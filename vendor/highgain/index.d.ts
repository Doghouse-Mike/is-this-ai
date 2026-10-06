export declare function channel<T extends ChannelFunctions>(channelName?: string): Transceiver<T>;

export declare type ChannelFunctions = Record<string, FunctionType>;

declare type FunctionType = (...args: any[]) => any;

declare interface Transceiver<T extends ChannelFunctions> {
    createTx: (worker?: Worker) => Tx<T>;
    rx: (receivers: T, worker?: Worker) => void;
}

export declare function transfer<T>(value: T, transfer?: Transferable | Transferable[]): T;

declare type Tx<T extends ChannelFunctions> = {
    [Name in keyof T]: (...args: Parameters<T[Name]>) => Promise<Awaited<ReturnType<T[Name]>>>;
};

export { }
