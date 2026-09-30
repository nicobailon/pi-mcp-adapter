/** Resolve and periodically refresh one command-backed bearer token. */
export declare class BearerCommandResolver {
    #private;
    constructor(command: string, context: string, ttlMs?: number);
    resolve(signal?: AbortSignal): Promise<string>;
}
