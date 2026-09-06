import { Container } from "@cloudflare/containers";

export class CodexEgress extends Container {
  override defaultPort = 8080;
  override sleepAfter = "30s";
}
