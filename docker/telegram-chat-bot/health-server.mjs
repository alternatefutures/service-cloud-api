import http from 'node:http'

const port = Number(process.env.PORT || 3000)

const server = http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('telegram-chat-bot ok\n')
    return
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found\n')
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[health] listening on 0.0.0.0:${port}`)
})
