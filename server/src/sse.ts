import type { SSEStreamingApi } from 'hono/streaming'

// Bun closes sockets that move no bytes for `idleTimeout` seconds, and
// proxies apply idle limits of their own, so a silent SSE stream dies ~10s
// after its last event. Writing a comment every 15s keeps the connection
// alive end-to-end. The loop returns once the client is gone (abort or a
// failed write) so the handler context can be garbage collected — an
// endless `while (true) sleep` here retains every closed connection's
// closures forever and leaks the process to an OOM kill.
export async function keepAlive(stream: SSEStreamingApi): Promise<void> {
  let closed = false
  const aborted = new Promise<void>((resolve) =>
    stream.onAbort(() => {
      closed = true
      resolve()
    })
  )
  while (!closed && !stream.aborted && !stream.closed) {
    await Promise.race([stream.sleep(15_000), aborted])
    if (closed || stream.aborted || stream.closed) break
    try {
      await stream.write(': keep-alive\n\n')
    } catch {
      break
    }
  }
}
