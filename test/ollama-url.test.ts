import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOllamaUrl } from "../src/ollama-url.ts";

test("Ollama configuration stays on an allowed local endpoint", () => {
  assert.equal(resolveOllamaUrl(undefined), "http://localhost:11434");
  assert.equal(resolveOllamaUrl("http://host.docker.internal:11434"), "http://host.docker.internal:11434");
  assert.equal(resolveOllamaUrl("http://host.containers.internal"), "http://host.containers.internal:11434");
  assert.throws(() => resolveOllamaUrl("https://api.example.test"));
  assert.throws(() => resolveOllamaUrl("http://192.168.1.10:11434"));
  assert.throws(() => resolveOllamaUrl("http://localhost:8080"));
  assert.throws(() => resolveOllamaUrl("http://user:pass@localhost:11434"));
  assert.throws(() => resolveOllamaUrl("http://localhost:11434/api"));
});
