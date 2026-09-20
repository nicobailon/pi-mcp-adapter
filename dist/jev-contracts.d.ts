export type JevJson = null | boolean | number | string | JevJson[] | {
    [key: string]: JevJson;
};
export type JevQuestion = {
    type: "choice";
    instructions?: JevJson;
    criteria: Record<string, JevJson>;
} | {
    type: "score";
    instructions?: JevJson;
    criteria: [JevJson, JevJson, ...JevJson[]];
} | {
    type: "noul";
    instructions?: JevJson;
    criteria?: {
        true?: JevJson;
        false?: JevJson;
    };
};
export interface JevEvaluateInput {
    state: JevJson;
    questions: Record<string, JevQuestion>;
    /** MCP servers whose metadata/results were copied into state. Empty/omitted means no MCP-derived data. */
    sources?: string[];
}
export type JevAnswer = {
    type: "choice";
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
} | {
    type: "score";
    score: number;
    confidence: number;
    probabilities: Record<string, number>;
} | {
    type: "noul";
    noul: number;
};
export interface JevEvaluationData {
    answers: Record<string, JevAnswer>;
    model: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
}
export type JevErrorCode = "disabled" | "invalid_request" | "data_policy_denied" | "budget_exhausted" | "credential_missing" | "credential_unavailable" | "authentication_failed" | "timeout" | "aborted" | "rate_limited" | "service_unavailable" | "invalid_response";
export type JevEvaluationEnvelope = {
    ok: true;
    data: JevEvaluationData;
} | {
    ok: false;
    error: {
        code: JevErrorCode;
        message: string;
        retryable?: boolean;
    };
};
export interface ResolvedJevSettings {
    semanticSearch: boolean;
    scriptEvaluation: boolean;
    allowedServers: string[];
    model: string;
    requestTimeoutMs: number;
    maxRetries: number;
    maxStateBytes: number;
    maxQuestionsPerRequest: number;
    maxEvaluationsPerScript: number;
    maxEvaluationBytesPerScript: number;
    maxEvaluationTokensPerScript: number;
    semanticCandidateLimit: number;
    semanticMinProbability: number;
}
export interface JevBudget {
    consume(bytes: number): boolean;
}
