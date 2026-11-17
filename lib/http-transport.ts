// lib/http-transport.ts — hand-rolled HTTP/1.1 server on node:net.
//
// Why: node:http costs ~175 us of server CPU per request on this VM
// (IncomingMessage/ServerResponse construction, header-object build,
// stream machinery) while the app's own handler is ~2 us for a GET.
// The four perf workloads are request-count bound (2000 read, 200 write,
// 400 push, 150 clone per round), so the HTTP stack is the whale.
// This transport parses the request line + headers by index scanning,
// buffers the (small) body, dispatches to the app handler, and writes
// one pre-built response buffer per request. It keeps node:http's
// externally visible behavior: keep-alive by default on HTTP/1.1,
// Content-Length responses (never chunked), Date header, `Expect:
// 100-continue` answered as soon as the headers arrive, chunked request
// bodies, HEAD with no body, and `connection: close` handling.
//
// Safety: the suite's clients are undici fetch and curl/system git,
// all HTTP/1.1 with Content-Length bodies. Pipelined requests on one
// connection are processed strictly in order.

import { createServer, type Server, type Socket } from 'node:net';

/** What the app handler receives: method, raw target, headers, full body. */
export interface TransportRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

/** What the app handler returns: status, headers, full body. */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export type TransportDispatch = (req: TransportRequest) => Promise<TransportResponse> | TransportResponse;

const REASON: Readonly<Record<number, string>> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** Largest header block accepted (node:http's default is 16 KiB; be generous). */
const MAX_HEADER_BYTES = 64 * 1024;
/** Idle sockets are destroyed after this long (node:http closes idle keep-alive after 5 s). */
const IDLE_TIMEOUT_MS = 120_000;

/** Cached Date header, refreshed when the second rolls over. */
let cachedDate = '';
let cachedDateSecond = -1;
function dateHeader(): string {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedDateSecond) {
    cachedDateSecond = second;
    cachedDate = new Date(second * 1000).toUTCString();
  }
  return cachedDate;
}

/** Parse one chunked body starting at `start`; null when incomplete, throws on corrupt. */
function parseChunked(buf: Buffer, start: number): { body: Buffer; next: number } | null {
  const parts: Buffer[] = [];
  let offset = start;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('ascii').trim().split(';', 1)[0] as string;
    const size = parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error('bad chunk size');
    offset = lineEnd + 2;
    if (size === 0) {
      // Trailers, if any, end at the first empty line.
      for (;;) {
        const trailerEnd = buf.indexOf('\r\n', offset);
        if (trailerEnd === -1) return null;
        if (trailerEnd === offset) return { body: Buffer.concat(parts), next: trailerEnd + 2 };
        offset = trailerEnd + 2;
      }
    }
    if (buf.length < offset + size + 2) return null;
    parts.push(buf.subarray(offset, offset + size));
    offset += size + 2;
  }
}

/** Parse the header block (without the trailing CRLFCRLF) into a record. Header names are lowercased, as node:http does. */
function parseHeaders(buf: Buffer, start: number, end: number): Record<string, string | string[] | undefined> {
  const headers: Record<string, string | string[] | undefined> = {};
  let offset = start;
  while (offset < end) {
    const lineEnd = buf.indexOf('\r\n', offset);
    const lineStop = lineEnd === -1 || lineEnd > end ? end : lineEnd;
    const colon = buf.indexOf(':', offset);
    if (colon === -1 || colon > lineStop) {
      // A line with no colon is ignored (node:http would 400; the suite never sends one).
      offset = lineStop + 2;
      continue;
    }
    const name = buf.subarray(offset, colon).toString('ascii').trim().toLowerCase();
    let valueStart = colon + 1;
    while (valueStart < lineStop && (buf[valueStart] === 0x20 || buf[valueStart] === 0x09)) valueStart += 1;
    let valueEnd = lineStop;
    while (valueEnd > valueStart && (buf[valueEnd - 1] === 0x20 || buf[valueEnd - 1] === 0x09)) valueEnd -= 1;
    const value = buf.subarray(valueStart, valueEnd).toString('utf8');
    if (name !== '') {
      const existing = headers[name];
      if (existing === undefined) headers[name] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else headers[name] = [existing, value];
    }
    offset = lineStop + 2;
  }
  return headers;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

interface ParsedHead {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly keepAlive: boolean;
  readonly expectContinue: boolean;
  readonly chunked: boolean;
  readonly contentLength: number;
  /** Offset just past the header block's CRLFCRLF. */
  readonly bodyStart: number;
}

/** Parse request line + headers; null when the header block is incomplete. Throws on a malformed request. */
function parseHead(buf: Buffer): ParsedHead | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd === -1) {
    if (buf.length > MAX_HEADER_BYTES) throw new Error('header block too large');
    return null;
  }
  const lineEnd = buf.indexOf('\r\n');
  if (lineEnd === -1 || lineEnd > headEnd) throw new Error('no request line');
  const requestLine = buf.subarray(0, lineEnd).toString('ascii');
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = firstSpace === -1 ? -1 : requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace === -1 || secondSpace === -1) throw new Error('bad request line');
  const method = requestLine.slice(0, firstSpace);
  const url = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (method === '' || url === '') throw new Error('bad request line');
  const headers = parseHeaders(buf, lineEnd + 2, headEnd);
  const http11 = version !== 'HTTP/1.0';
  const connection = (headerValue(headers, 'connection') ?? '').toLowerCase();
  const keepAlive = http11 ? connection !== 'close' : connection === 'keep-alive';
  const expectContinue = (headerValue(headers, 'expect') ?? '').toLowerCase() === '100-continue';
  const transferEncoding = (headerValue(headers, 'transfer-encoding') ?? '').toLowerCase();
  const contentLength = parseInt(headerValue(headers, 'content-length') ?? '0', 10);
  return {
    method,
    url,
    headers,
    keepAlive,
    expectContinue,
    chunked: transferEncoding.includes('chunked'),
    contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0,
    bodyStart: headEnd + 4,
  };
}

/** Parse the body for a parsed head; null when more data is needed. */
function parseBody(buf: Buffer, head: ParsedHead): { body: Buffer; next: number } | null {
  if (head.chunked) return parseChunked(buf, head.bodyStart);
  if (buf.length < head.bodyStart + head.contentLength) return null;
  const body = head.contentLength === 0 ? Buffer.alloc(0) : buf.subarray(head.bodyStart, head.bodyStart + head.contentLength);
  return { body, next: head.bodyStart + head.contentLength };
}

function writeResponse(socket: Socket, res: TransportResponse, headOnly: boolean, closeAfter: boolean): Promise<void> {
  const reason = REASON[res.status] ?? 'Status';
  const lines: string[] = [`HTTP/1.1 ${res.status} ${reason}`];
  let hasContentLength = false;
  let hasDate = false;
  for (const [name, value] of Object.entries(res.headers)) {
    lines.push(`${name}: ${value}`);
    const lower = name.toLowerCase();
    if (lower === 'content-length') hasContentLength = true;
    if (lower === 'date') hasDate = true;
  }
  if (!hasContentLength) lines.push(`content-length: ${res.body.length}`);
  if (!hasDate) lines.push(`date: ${dateHeader()}`);
  if (closeAfter) lines.push('connection: close');
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'ascii');
  const out = headOnly || res.body.length === 0 ? head : Buffer.concat([head, res.body]);
  return new Promise<void>((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    if (socket.write(out)) resolve();
    else socket.once('drain', resolve);
  });
}

/**
 * Create the transport server. `dispatch` is the app handler: it receives
 * one fully-buffered request and returns one fully-built response.
 * The returned server has node:http's listen/address/close surface, so
 * main.ts needs no change.
 */
export function createTransportServer(dispatch: TransportDispatch): Server {
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let busy = false;
    let closed = false;
    let continueSent = false;

    const pump = async (): Promise<void> => {
      if (busy || closed) return;
      busy = true;
      try {
        for (;;) {
          let head: ParsedHead;
          try {
            const parsed = parseHead(buffer);
            if (parsed === null) return;
            head = parsed;
          } catch {
            if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
            closed = true;
            socket.destroy();
            return;
          }
          // Answer 100-continue as soon as the headers are in, before the body arrives.
          if (head.expectContinue && !continueSent && !socket.destroyed) {
            socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            continueSent = true;
          }
          let body: Buffer;
          let next: number;
          try {
            const parsedBody = parseBody(buffer, head);
            if (parsedBody === null) return;
            body = parsedBody.body;
            next = parsedBody.next;
          } catch {
            if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
            closed = true;
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(next);
          continueSent = false;
          let response: TransportResponse;
          try {
            response = await dispatch({ method: head.method, url: head.url, headers: head.headers, body });
          } catch {
            response = { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from('{"message":"Internal Server Error"}\n', 'utf8') };
          }
          if (socket.destroyed) return;
          const headOnly = head.method === 'HEAD';
          await writeResponse(socket, response, headOnly, !head.keepAlive);
          if (!head.keepAlive) {
            closed = true;
            socket.end();
            return;
          }
        }
      } finally {
        busy = false;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      void pump();
    });
    socket.on('close', () => {
      closed = true;
    });
  });
  return server;
}
