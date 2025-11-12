import http from "http";

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Server is running on Render!");
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
