export interface NpxResolution {
    binPath: string;
    extraArgs: string[];
    isJs: boolean;
}
export declare function resolveNpxBinary(command: string, args: string[], signal?: AbortSignal): Promise<NpxResolution | null>;
