import net from "net";

const server = net.createServer((socket) => {
    console.log("client connected");

    socket.write(":irc-server NOTICE * :Serbus from my IRC server\r\n");

    socket.on("data", (data) => {
        const lines = data.toString().split("\r\n");

        for (const line of lines) {
            if (!line) continue;

            console.log("received:", line);

            if (line.startsWith("PING")) {
                socket.write("PONG :irc-server\r\n");
            }
        }
    });

    socket.on("close", () => {
        console.log("client disconnected");
    });
});

server.listen(6667, () => {
    console.log("irc-server running on port 6667");
});