import net from "net";

const usedNicks = new Set<string>();
const channels = new Map<string, Set<net.Socket>>();
const clientsByNick = new Map<string, net.Socket>();
const topics = new Map<string, string>();
const channelOperators = new Map<string, Set<net.Socket>>();
const inviteOnlyChannels = new Set<string>();
const channelInvites = new Map<string, Set<string>>();

const server = net.createServer((socket) => {
    let nick = "";
    let username = "";
    let realname = "";
    let registered = false;
    let awayMessage = "";

    function send(line: string) {
        socket.write(line + "\r\n");
    }

    function tryRegister() {
        if (!registered && nick && username) {
            registered = true;
            send(`:irc-server 001 ${nick} :Serbus to my irc-server`);
        }
    }

    console.log("client connected");

    socket.on("data", (data) => {
        const lines = data.toString().split("\r\n");

        for (const line of lines) {
            if (!line) continue;

            console.log("received:", line);

            if (line.startsWith("PING")) {
                if (nick) {
                    send(`PONG ${nick}`);
                } else {
                    send("PONG :irc-server");
                }
            }

            if (line.trim() === "MOTD") {
                send(`:irc-server 375 ${nick} :- irc-server Message of the Day -`);
                send(`:irc-server 372 ${nick} :- Serbus, welcome to my tiny IRC server`);
                send(`:irc-server 376 ${nick} :End of /MOTD command`);
            }

            if (line.startsWith("NICK ")) {
                const requestedNick = line.split(" ")[1].trim();

                if (usedNicks.has(requestedNick)) {
                    send(`:irc-server 433 * ${requestedNick} :Nickname already in use`);
                    continue;
                }

                if (nick) {
                    usedNicks.delete(nick);
                    clientsByNick.delete(nick);
                }

                nick = requestedNick;

                usedNicks.add(nick);
                clientsByNick.set(nick, socket);

                (socket as any).nick = nick;

                console.log("nickname set to:", nick);

                tryRegister();
            }

            if (line.startsWith("USER ")) {
                const parts = line.split(" ");

                username = parts[1].trim();
                realname = line.split(" :")[1]?.trim() ?? "";

                console.log("username set to:", username);
                console.log("realname set to:", realname);

                (socket as any).username = username;
                (socket as any).realname = realname;

                tryRegister();
            }

            if (line.startsWith("AWAY")) {
                const message = line.split(" :")[1]?.trim();

                if (message) {
                    awayMessage = message;
                    (socket as any).awayMessage = awayMessage;

                    send(`:irc-server 306 ${nick} :You have been marked as being away`);
                } else {
                    awayMessage = "";
                    (socket as any).awayMessage = "";

                    send(`:irc-server 305 ${nick} :You are no longer marked as being away`);
                }
            }

            if (line.startsWith("JOIN ")) {
                const channel = line.split(" ")[1].trim();

                if (!nick) {
                    send(":irc-server 451 * :You have not registered");
                    continue;
                }

                if (!channel.startsWith("#")) {
                    send(`:irc-server 403 ${nick} ${channel} :No such channel`);
                    continue;
                }

                if (!channels.has(channel)) {
                    channels.set(channel, new Set());
                }

                if (inviteOnlyChannels.has(channel)) {
                    const invites = channelInvites.get(channel);

                    if (!invites?.has(nick)) {
                        send(`:irc-server 473 ${nick} ${channel} :Cannot join channel (+i)`);
                        continue;
                    }

                    invites.delete(nick);
                }

                channels.get(channel)!.add(socket);
                if (!channelOperators.has(channel)) {
                    channelOperators.set(channel, new Set());
                }

                if (channelOperators.get(channel)!.size === 0) {
                    channelOperators.get(channel)!.add(socket);
                }
                for (const member of channels.get(channel)!) {
                    member.write(`:${nick}!${username}@localhost JOIN ${channel}\r\n`);
                }
                const topic = topics.get(channel);

                if (topic) {
                    send(`:irc-server 332 ${nick} ${channel} :${topic}`);
                } else {
                    send(`:irc-server 331 ${nick} ${channel} :No topic is set`);
                }
                const members = [...channels.get(channel)!]
                    .map((s) => {
                        const isOp = channelOperators.get(channel)?.has(s);
                        return (isOp ? "@" : "") + (s as any).nick;
                    })
                    .filter(Boolean)
                    .join(" ");

                send(`:irc-server 353 ${nick} = ${channel} :${members}`);
                send(`:irc-server 366 ${nick} ${channel} :End of /NAMES list`);
            }

            if (line.startsWith("INVITE ")) {
                const parts = line.split(" ");
                const targetNick = parts[1]?.trim();
                const channel = parts[2]?.trim();

                if (!targetNick || !channel) continue;

                const members = channels.get(channel);
                const ops = channelOperators.get(channel);

                if (!members) {
                    send(`:irc-server 403 ${nick} ${channel} :No such channel`);
                    continue;
                }

                if (!members.has(socket)) {
                    send(`:irc-server 442 ${nick} ${channel} :You're not on that channel`);
                    continue;
                }

                if (!ops?.has(socket)) {
                    send(`:irc-server 482 ${nick} ${channel} :You're not channel operator`);
                    continue;
                }

                const targetSocket = clientsByNick.get(targetNick);

                if (!targetSocket) {
                    send(`:irc-server 401 ${nick} ${targetNick} :No such nick`);
                    continue;
                }

                if (!channelInvites.has(channel)) {
                    channelInvites.set(channel, new Set());
                }

                channelInvites.get(channel)!.add(targetNick);

                targetSocket.write(
                    `:${nick}!${username}@localhost INVITE ${targetNick} :${channel}\r\n`
                );

                send(`:irc-server 341 ${nick} ${targetNick} ${channel}`);
            }

            if (line.startsWith("MODE ")) {
                const parts = line.split(" ");
                const target = parts[1]?.trim();
                const mode = parts[2]?.trim();

                if (!target) continue;

                if (target.startsWith("#")) {
                    if (!channels.has(target)) {
                        send(`:irc-server 403 ${nick} ${target} :No such channel`);
                        continue;
                    }

                    const ops = channelOperators.get(target);

                    if ((mode === "+i" || mode === "-i" || mode === "+o") && !ops?.has(socket)) {
                        send(`:irc-server 482 ${nick} ${target} :You're not channel operator`);
                        continue;
                    }

                    if (mode === "+i") {
                        inviteOnlyChannels.add(target);
                        send(`:${nick}!${username}@localhost MODE ${target} +i`);
                        continue;
                    }

                    if (mode === "-i") {
                        inviteOnlyChannels.delete(target);
                        send(`:${nick}!${username}@localhost MODE ${target} -i`);
                        continue;
                    }

                    if (mode === "+o") {
                        const targetNick = parts[3]?.trim();

                        if (!targetNick) continue;

                        if (!ops?.has(socket)) {
                            send(`:irc-server 482 ${nick} ${target} :You're not channel operator`);
                            continue;
                        }

                        const targetSocket = clientsByNick.get(targetNick);

                        if (!targetSocket || !channels.get(target)?.has(targetSocket)) {
                            send(`:irc-server 441 ${nick} ${targetNick} ${target} :They aren't on that channel`);
                            continue;
                        }

                        ops.add(targetSocket);

                        for (const member of channels.get(target)!) {
                            member.write(
                                `:${nick}!${username}@localhost MODE ${target} +o ${targetNick}\r\n`
                            );
                        }

                        continue;
                    }

                    if (mode === "-o") {
                        const targetNick = parts[3]?.trim();

                        if (!targetNick) continue;

                        const ops = channelOperators.get(target);

                        if (!ops?.has(socket)) {
                            send(`:irc-server 482 ${nick} ${target} :You're not channel operator`);
                            continue;
                        }

                        const targetSocket = clientsByNick.get(targetNick);

                        if (!targetSocket || !channels.get(target)?.has(targetSocket)) {
                            send(`:irc-server 441 ${nick} ${targetNick} ${target} :They aren't on that channel`);
                            continue;
                        }

                        ops.delete(targetSocket);

                        // prevent removing the last operator
                        if (ops.size === 0) {
                            ops.add(targetSocket);
                            send(`:irc-server 482 ${nick} ${target} :Cannot remove last operator`);
                            continue;
                        }

                        for (const member of channels.get(target)!) {
                            member.write(
                                `:${nick}!${username}@localhost MODE ${target} -o ${targetNick}\r\n`
                            );
                        }

                        continue;
                    }

                    send(`:irc-server 324 ${nick} ${target} ${inviteOnlyChannels.has(target) ? "+i" : "+"}`);
                }
            }

            if (line.startsWith("PART ")) {
                const channel = line.split(" ")[1]?.trim();

                if (!channel) continue;

                const members = channels.get(channel);

                if (!members || !members.has(socket)) {
                    send(`:irc-server 442 ${nick} ${channel} :You're not on that channel`);
                    continue;
                }

                for (const member of members) {
                    member.write(`:${nick}!${username}@localhost PART ${channel}\r\n`);
                }

                members.delete(socket);

                const ops = channelOperators.get(channel);

                if (ops && ops.size === 0 && members.size > 0) {
                    const iterator = members.values().next();

                    if (!iterator.done) {
                        ops.add(iterator.value);
                    }
                }

                if (members.size === 0) {
                    channels.delete(channel);
                }
            }

            if (line.trim() === "LIST") {
                send(`:irc-server 321 ${nick} Channel :Users Name`);

                for (const [channel, members] of channels) {
                    const topic = topics.get(channel) ?? "No topic";
                    send(`:irc-server 322 ${nick} ${channel} ${members.size} :${topic}`);
                }

                send(`:irc-server 323 ${nick} :End of /LIST`);
            }

            if (line.startsWith("TOPIC ")) {
                const channel = line.split(" ")[1];
                const newTopic = line.split(" :")[1];

                if (!channel) continue;

                if (!channels.has(channel)) {
                    send(`:irc-server 403 ${nick} ${channel} :No such channel`);
                    continue;
                }

                // set topic
                if (newTopic) {
                    topics.set(channel, newTopic.trim());

                    for (const member of channels.get(channel)!) {
                        member.write(
                            `:${nick}!${username}@localhost TOPIC ${channel} :${newTopic}\r\n`
                        );
                    }
                } else {
                    // show topic
                    const topic = topics.get(channel);

                    if (topic) {
                        send(`:irc-server 332 ${nick} ${channel} :${topic}`);
                    } else {
                        send(`:irc-server 331 ${nick} ${channel} :No topic is set`);
                    }
                }
            }

            if (line.startsWith("KICK ")) {
                const parts = line.split(" ");
                const channel = parts[1]?.trim();
                const targetNick = parts[2]?.trim();
                const reason = line.split(" :")[1]?.trim() ?? "Kicked";

                if (!channel || !targetNick) continue;

                const members = channels.get(channel);
                const operators = channelOperators.get(channel);

                if (!members || !members.has(socket)) {
                    send(`:irc-server 442 ${nick} ${channel} :You're not on that channel`);
                    continue;
                }

                if (!operators?.has(socket)) {
                    send(`:irc-server 482 ${nick} ${channel} :You're not channel operator`);
                    continue;
                }

                const targetSocket = clientsByNick.get(targetNick);

                if (!targetSocket || !members.has(targetSocket)) {
                    send(`:irc-server 441 ${nick} ${targetNick} ${channel} :They aren't on that channel`);
                    continue;
                }

                for (const member of members) {
                    member.write(`:${nick}!${username}@localhost KICK ${channel} ${targetNick} :${reason}\r\n`);
                }

                members.delete(targetSocket);

                const ops = channelOperators.get(channel);

                if (ops) {
                    ops.delete(targetSocket);

                    if (ops.size === 0 && members.size > 0) {
                        const iterator = members.values().next();

                        if (!iterator.done) {
                            ops.add(iterator.value);
                        }
                    }
                }
            }

            if (line.startsWith("NAMES")) {
                const channel = line.split(" ")[1]?.trim();

                if (!channel || !channels.has(channel)) {
                    send(`:irc-server 366 ${nick} ${channel ?? "*"} :End of /NAMES list`);
                    continue;
                }

                const members = [...channels.get(channel)!]
                    .map((s) => {
                        const isOp = channelOperators.get(channel)?.has(s);
                        return (isOp ? "@" : "") + (s as any).nick;
                    })
                    .filter(Boolean)
                    .join(" ");

                send(`:irc-server 353 ${nick} = ${channel} :${members}`);
                send(`:irc-server 366 ${nick} ${channel} :End of /NAMES list`);
            }

            if (line.startsWith("PRIVMSG ")) {
                const target = line.split(" ")[1];
                const message = line.split(" :")[1];

                if (!nick || !username) {
                    send(":irc-server 451 * :You have not registered");
                    continue;
                }

                if (!target || !message) {
                    continue;
                }

                if (target.startsWith("#")) {
                    const members = channels.get(target);

                    if (!members) {
                        send(`:irc-server 403 ${nick} ${target} :No such channel`);
                        continue;
                    }

                    if (!members.has(socket)) {
                        send(`:irc-server 442 ${nick} ${target} :You're not on that channel`);
                        continue;
                    }

                    for (const member of members) {
                        member.write(
                            `:${nick}!${username}@localhost PRIVMSG ${target} :${message}\r\n`
                        );
                    }
                } else {
                    const recipient = clientsByNick.get(target);

                    if (!recipient) {
                        send(`:irc-server 401 ${nick} ${target} :No such nick`);
                        continue;
                    }

                    recipient.write(`:${nick}!${username}@localhost PRIVMSG ${target} :${message}\r\n`);
                    const awayMessage = (recipient as any).awayMessage ?? "";

                    if (awayMessage) {
                        send(`:irc-server 301 ${nick} ${target} :${awayMessage}`);
                    }
                    send(`:${nick}!${username}@localhost PRIVMSG ${target} :${message}`);
                }
            }

            if (line.startsWith("NOTICE ")) {
                const target = line.split(" ")[1];
                const message = line.split(" :")[1];

                if (!target || !message) continue;

                if (target.startsWith("#")) {
                    const members = channels.get(target);
                    if (!members) continue;

                    for (const member of members) {
                        member.write(
                            `:${nick}!${username}@localhost NOTICE ${target} :${message}\r\n`
                        );
                    }
                } else {
                    const recipient = clientsByNick.get(target);
                    if (!recipient) continue;

                    recipient.write(
                        `:${nick}!${username}@localhost NOTICE ${target} :${message}\r\n`
                    );
                }
            }

            if (line.startsWith("WHOIS ")) {
                const target = line.split(" ")[1]?.trim();

                if (!target) continue;

                const client = clientsByNick.get(target);

                if (!client) {
                    send(`:irc-server 401 ${nick} ${target} :No such nick`);
                    continue;
                }

                const username = (client as any).username ?? "unknown";
                const realname = (client as any).realname ?? "unknown";


                send(`:irc-server 311 ${nick} ${target} ${username} localhost * :${realname}`);
                const awayMessage = (client as any).awayMessage ?? "";

                if (awayMessage) {
                    send(`:irc-server 301 ${nick} ${target} :${awayMessage}`);
                }
                send(`:irc-server 318 ${nick} ${target} :End of WHOIS list`);
            }

            if (line.trim() === "LUSERS") {
                const userCount = clientsByNick.size;
                const channelCount = channels.size;

                send(
                    `:irc-server 251 ${nick} :There are ${userCount} users and ${channelCount} channels`
                );
            }

            if (line.startsWith("QUIT")) {
                const message = line.split(" :")[1] ?? "Client quit";

                for (const [channel, members] of channels) {
                    if (members.has(socket)) {
                        for (const member of members) {
                            if (member !== socket) {
                                member.write(
                                    `:${nick}!${username}@localhost QUIT :${message}\r\n`
                                );
                            }
                        }

                        const ops = channelOperators.get(channel);

                        if (ops) {
                            ops.delete(socket);

                            if (ops.size === 0 && members.size > 0) {
                                const iterator = members.values().next();

                                if (!iterator.done) {
                                    ops.add(iterator.value);
                                }
                            }
                        }

                        if (members.size === 0) {
                            channels.delete(channel);
                        }
                    }
                }

                if (nick) {
                    usedNicks.delete(nick);
                    clientsByNick.delete(nick);
                }

                socket.end();
            }
        }
    });

    socket.on("close", () => {
        if (nick) {
            usedNicks.delete(nick);
            clientsByNick.delete(nick);
        }

        for (const [channel, members] of channels) {
            if (members.has(socket)) {
                members.delete(socket);

                for (const member of members) {
                    member.write(`:${nick}!${username}@localhost QUIT :Client disconnected\r\n`);
                }

                if (members.size === 0) {
                    channels.delete(channel);
                }
            }
        }

        console.log(`${nick || "client"} disconnected`);
    });
});

server.listen(6667, () => {
    console.log("irc-server running on port 6667");
});