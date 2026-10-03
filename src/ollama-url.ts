const LOCAL_OLLAMA_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "host.docker.internal",
  "host.containers.internal",
]);

export function resolveOllamaUrl(raw: string | undefined): string {
  const value = raw ?? "http://localhost:11434";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP_LAB_OLLAMA_URL must be a local Ollama origin");
  }
  if (
    url.protocol !== "http:" ||
    !LOCAL_OLLAMA_HOSTS.has(url.hostname) ||
    (url.port !== "" && url.port !== "11434") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("MCP_LAB_OLLAMA_URL must use a trusted local host on port 11434");
  }
  if (!url.port) url.port = "11434";
  return url.origin;
}
