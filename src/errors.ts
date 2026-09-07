export class CodexCloudError extends Error {
  public override readonly name: string = "CodexCloudError";
}

export class AuthenticationError extends CodexCloudError {
  public override readonly name: string = "AuthenticationError";
}

export class TokenRefreshError extends AuthenticationError {
  public override readonly name: string = "TokenRefreshError";

  public constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

export class ApiError extends CodexCloudError {
  public override readonly name: string = "ApiError";

  public constructor(
    message: string,
    public readonly status: number,
    public readonly method: string,
    public readonly url: string,
    public readonly requestId?: string,
    /**
     * Upstream error body, truncated. May echo submitted secrets, so it is kept
     * out of `message`; do not log it without redacting.
     */
    public readonly detail?: string,
  ) {
    super(message);
  }
}
