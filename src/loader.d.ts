declare module '@permaweb/ao-loader' {
declare function _exports(binary: ArrayBuffer, options: Options): Promise<handleFunction>;
export = _exports;
export type Tag = {
    name: string;
    value: string;
};
export type Message = {
    Signature?: string;
    Owner: string;
    Target: string;
    Anchor?: string;
    Tags: Tag[];
    Data?: DataItem;
    From: string;
    "Forwarded-By"?: string;
    Epoch?: string;
    Nonce?: string;
    "Block-Height": string;
    Timestamp: string;
    "Hash-Chain"?: string;
    Cron: boolean;
};
export namespace AssignmentTypes {
    type Message = string;
    type Processes = string[];
    type Assignment = {
        Processes: AssignmentTypes.Processes;
        Message: AssignmentTypes.Message;
    };
}
export type Environment = {
    process: {
        id: string;
        owner: string;
        tags: Tag[];
    };
};
export type HandleResponse = {
    Memory: ArrayBuffer;
    Output: DataItem;
    Messages: Message[];
    Spawns: Message[];
    Assignments: AssignmentTypes.Assignment[];
};
export type handleFunction = (buffer: ArrayBuffer | NULL, msg: Message, env: Environment) => HandleResponse;
export type Options = {
    format: string;
    input: string;
    output: string;
    memory: string;
    compute: string;
    extensions: string[];
};
}