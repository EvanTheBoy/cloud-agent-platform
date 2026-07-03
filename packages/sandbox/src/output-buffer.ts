export class OutputBuffer {
  private value = "";
  private truncated = false;

  constructor(private readonly limit = 20_000) {}

  append(chunk: Buffer): void {
    if (this.value.length >= this.limit) {
      this.truncated = true;
      return;
    }

    const text = chunk.toString("utf8");
    const remaining = this.limit - this.value.length;
    if (text.length > remaining) {
      this.value += text.slice(0, remaining);
      this.truncated = true;
      return;
    }

    this.value += text;
  }

  toString(): string {
    return this.truncated ? `${this.value}\n[output truncated]\n` : this.value;
  }
}
