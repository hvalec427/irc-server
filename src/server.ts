import net from "net";

const server = net.createServer((socket) => {
    console.log("client connected");

    socket.write(":irc-server NOTICE * :Serbus from my IRC server\r\n");

    socket.on("data", (data) => {
        console.log("received:", data.toString());
    });

    socket.on("close", () => {
        console.log("client disconnected");
    });
});

server.listen(6667, () => {
    console.log("irc-server running on port 6667");
});