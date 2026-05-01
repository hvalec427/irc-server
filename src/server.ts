import net from "net";

const server = net.createServer((socket) => {
    let nick = "";

    console.log("client connected");

    socket.write(":irc-server NOTICE * :Serbus from my IRC server\r\n");

    socket.on("data", (data) => {
        const lines = data.toString().split("\r\n");

        for (const line of lines) {
            if (!line) continue;

            console.log("received:", line);

            if (line.startsWith("PING")) {
                if (nick) {
                    socket.write(`PONG ${nick}\r\n`);
                } else {
                    socket.write("PONG :irc-server\r\n");
                }
            }

            if (line.startsWith("NICK ")) {
                nick = line.split(" ")[1];
                console.log("nickname set to:", nick);

                socket.write(`:irc-server NOTICE ${nick} :Nickname set to ${nick}\r\n`);
            }
        }
    });

    socket.on("close", () => {
        console.log(`${nick || "client"} disconnected`);
    });
});

server.listen(6667, () => {
    console.log("irc-server running on port 6667");
});