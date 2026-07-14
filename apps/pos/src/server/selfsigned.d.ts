declare module "selfsigned" {
  interface GeneratedPems {
    private: string;
    public: string;
    cert: string;
  }
  interface GenerateOptions {
    days?: number;
    keySize?: number;
  }
  export function generate(
    attrs: Array<{ name: string; value: string }>,
    options?: GenerateOptions,
  ): Promise<GeneratedPems>;
  const selfsigned: { generate: typeof generate };
  export default selfsigned;
}
