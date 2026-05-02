import fs from "fs";
import path from "path";

export type ChannelState = {
    topic: string | null;
    modes: {
        inviteOnly: boolean;
        topicProtected: boolean;
        key: string | null;
        limit: number | null;
    };
    operators: string[];
};

export type ServerState = {
    accounts: Record<string, string>;
    channels: Record<string, ChannelState>;
};

const stateFilePath = path.resolve(process.cwd(), "state.json");

export function readState(): ServerState {
    try {
        const raw = fs.readFileSync(stateFilePath, "utf8");
        const parsed = JSON.parse(raw);

        return {
            accounts: typeof parsed.accounts === "object" && parsed.accounts !== null ? parsed.accounts : {},
            channels: typeof parsed.channels === "object" && parsed.channels !== null ? parsed.channels : {},
        };
    } catch {
        return { accounts: {}, channels: {} };
    }
}

export function saveState(
    accounts: Map<string, string>,
    topics: Map<string, string>,
    inviteOnlyChannels: Set<string>,
    topicProtectedChannels: Set<string>,
    channelKeys: Map<string, string>,
    channelLimits: Map<string, number>,
    channelOperatorNames: Map<string, Set<string>>
) {
    const channelsState: Record<string, ChannelState> = {};
    const channelNames = new Set<string>();

    for (const channel of topics.keys()) {
        channelNames.add(channel);
    }
    for (const channel of inviteOnlyChannels) {
        channelNames.add(channel);
    }
    for (const channel of topicProtectedChannels) {
        channelNames.add(channel);
    }
    for (const channel of channelKeys.keys()) {
        channelNames.add(channel);
    }
    for (const channel of channelLimits.keys()) {
        channelNames.add(channel);
    }
    for (const channel of channelOperatorNames.keys()) {
        channelNames.add(channel);
    }

    for (const channel of channelNames) {
        channelsState[channel] = {
            topic: topics.get(channel) ?? null,
            modes: {
                inviteOnly: inviteOnlyChannels.has(channel),
                topicProtected: topicProtectedChannels.has(channel),
                key: channelKeys.get(channel) ?? null,
                limit: channelLimits.get(channel) ?? null,
            },
            operators: [...(channelOperatorNames.get(channel) ?? new Set<string>())],
        };
    }

    const state: ServerState = {
        accounts: Object.fromEntries(accounts),
        channels: channelsState,
    };

    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export function loadState(
    accounts: Map<string, string>,
    topics: Map<string, string>,
    inviteOnlyChannels: Set<string>,
    topicProtectedChannels: Set<string>,
    channelKeys: Map<string, string>,
    channelLimits: Map<string, number>,
    channelOperatorNames: Map<string, Set<string>>
) {
    const unlockedState = readState();
    for (const [nick, password] of Object.entries(unlockedState.accounts)) {
        if (typeof password === "string") {
            accounts.set(nick, password);
        }
    }

    for (const [channel, channelState] of Object.entries(unlockedState.channels)) {
        if (channelState.topic !== null) {
            topics.set(channel, channelState.topic);
        }
        if (channelState.modes.inviteOnly) {
            inviteOnlyChannels.add(channel);
        }
        if (channelState.modes.topicProtected) {
            topicProtectedChannels.add(channel);
        }
        if (channelState.modes.key !== null) {
            channelKeys.set(channel, channelState.modes.key);
        }
        if (typeof channelState.modes.limit === "number") {
            channelLimits.set(channel, channelState.modes.limit);
        }
        channelOperatorNames.set(channel, new Set(channelState.operators ?? []));
    }
}

export function startPeriodicSaving(saveFn: () => void) {
    const stateSaveInterval = setInterval(() => {
        try {
            saveFn();
        } catch (error) {
            console.error("Failed to save state:", error);
        }
    }, 30_000);

    function saveStateGracefully() {
        try {
            saveFn();
        } catch (error) {
            console.error("Failed to save state on shutdown:", error);
        }
    }

    process.on("SIGINT", () => {
        saveStateGracefully();
        clearInterval(stateSaveInterval);
        process.exit(0);
    });

    process.on("SIGTERM", () => {
        saveStateGracefully();
        clearInterval(stateSaveInterval);
        process.exit(0);
    });

    process.on("exit", () => {
        saveStateGracefully();
    });
}