export interface Credential {
  envVar: string | null;
  token: string | undefined;
  triedVars: string[];
}
