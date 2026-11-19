import { Buffer } from "node:buffer";
import { HTTPParser } from "npm:http-parser-js@0.5.10";
import { publicAddress } from "./core.ts";

const MAX_BODY = 600_000;
type Phase = "dns" | "connect" | "tls" | "headers" | "body" | "complete";
export type TransportStatus = { phase: Phase; status?: number; milliseconds: number; error?: "certificate" | "handshake" | "connection" | "http" };
export type Progress = Omit<TransportStatus, "milliseconds">;

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

async function resolvePublic(host: string, signal: AbortSignal) {
  const answers = await abortable(Promise.allSettled([Deno.resolveDns(host, "A"), Deno.resolveDns(host, "AAAA")]), signal);
  const addresses = [...new Set(answers.flatMap(answer => answer.status === "fulfilled" ? answer.value : []))];
  return addresses.every(publicAddress) ? addresses : [];
}

function close(connection?: Deno.Conn) {
  try { connection?.close(); } catch { /* TLS consumes its original TCP resource. */ }
}

async function connect(addresses: string[], port: number, signal: AbortSignal) {
  for (const [index, address] of addresses.slice(0, 2).entries()) {
    const attempt = index === 0 && addresses.length > 1 ? AbortSignal.any([signal, AbortSignal.timeout(3400)]) : signal;
    const pending = Deno.connect({ hostname: address, port }).then(connection => {
      if (attempt.aborted) { close(connection); throw attempt.reason; }
      return connection;
    });
    try { return await abortable(pending, attempt); }
    catch (error) {
      if (signal.aborted || index === 1 || addresses.length === 1) throw error;
    }
  }
  throw new Error("no_public_address");
}

export async function readReply(connection: Pick<Deno.Conn, "read">, progress: Progress) {
  let eof = false;
  let complete = false;
  let size = 0;
  let status = 0;
  let decode = new TextDecoder();
  const parts: string[] = [];
  const headers = new Headers();
  const parser = new HTTPParser(HTTPParser.RESPONSE);
  parser.maxHeaderSize = 32_768;
  parser.onHeadersComplete = (value) => {
    status = value.statusCode;
    if (status < 200 && status !== 101) return 1;
    progress.status = status;
    for (let index = 0; index + 1 < value.headers.length; index += 2) {
      const name = value.headers[index];
      if (/^(?:location|content-type|content-encoding)$/i.test(name)) headers.append(name, value.headers[index + 1]);
    }
    const encoding = headers.get("content-encoding");
    if (status < 200 || status >= 300 || !/html/i.test(headers.get("content-type") || "") ||
        (encoding && encoding.toLowerCase() !== "identity")) {
      complete = true;
      return 1;
    }
    progress.phase = "body";
    const charset = headers.get("content-type")?.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1];
    if (charset) {
      try { decode = new TextDecoder(charset); } catch { /* Default to UTF-8. */ }
    }
    return 0;
  };
  parser.onBody = (body, offset, length) => {
    const end = offset + Math.min(length, MAX_BODY - size);
    parts.push(decode.decode(body.subarray(offset, end), { stream: true }));
    size += end - offset;
  };
  parser.onMessageComplete = () => { if (status >= 200 || status === 101) complete = true; };
  const scratch = Buffer.alloc(16_384);
  while (!complete && size < MAX_BODY) {
    const length = await connection.read(scratch);
    if (length === null) { eof = true; break; }
    const outcome = parser.execute(scratch, 0, length);
    if (outcome instanceof Error && !complete) throw outcome;
  }
  if (eof) {
    const result = parser.finish();
    if (result instanceof Error) throw result;
  }
  if (!progress.status) throw new Error("no_http_headers");
  progress.phase = "complete";
  return { status, headers, html: parts.join("") + decode.decode() };
}

export async function downloadHtml(url: URL, signal: AbortSignal, progress: Progress) {
  progress.phase = "dns";
  delete progress.status;
  delete progress.error;
  const addresses = await resolvePublic(url.hostname, signal);
  if (!addresses.length) return null;
  const secure = url.protocol === "https:";
  let connection: Deno.Conn | undefined;
  const dispose = () => close(connection);
  signal.addEventListener("abort", dispose, { once: true });
  try {
    progress.phase = "connect";
    const tcp = await connect(addresses, secure ? 443 : 80, signal);
    connection = tcp;
    signal.throwIfAborted();
    if (secure) {
      progress.phase = "tls";
      const ssl = await abortable(Deno.startTls(tcp, { hostname: url.hostname }).then(tls => {
        if (signal.aborted) { close(tls); throw signal.reason; }
        connection = tls;
        return tls;
      }), signal);
      await abortable(ssl.handshake(), signal);
    }
    progress.phase = "headers";
    const request = new TextEncoder().encode(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: Monitor-Event/1.0\r\n` +
      "Accept: text/html,application/xhtml+xml\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
    );
    for (let offset = 0; offset < request.length;) offset += await connection.write(request.subarray(offset));
    return await readReply(connection, progress);
  } catch (error) {
    if (!signal.aborted) {
      progress.error = progress.phase === "tls"
        ? (error instanceof Error && /certific|issuer|notvalidforname/i.test(error.message) ? "certificate" : "handshake")
        : progress.phase === "connect" ? "connection" : "http";
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", dispose);
    dispose();
  }
}
