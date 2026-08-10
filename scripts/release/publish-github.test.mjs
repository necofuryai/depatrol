import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const publishScript = resolve(here, "publish-github.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "depatrol-publish-github-test-"));
  const bin = join(root, "bin");
  const log = join(root, "gh.log");
  const count = join(root, "api-count");
  const bundle = join(root, "bundle");
  mkdirSync(bin);
  mkdirSync(bundle);

  writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "node"), 0o755);

  const fakeGh = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = api ]; then
  case "$2" in
    */git/ref/tags/*)
      printf '{"object":{"type":"tag","sha":"tag-object-sha"}}\\n'
      exit 0
      ;;
    */git/tags/tag-object-sha)
      if [ "$FAKE_GH_SCENARIO" = remote-moved ]; then
        printf '{"tag":"v1.2.3","object":{"type":"commit","sha":"ffffffffffffffffffffffffffffffffffffffff"},"verification":{"verified":true,"reason":"valid"}}\\n'
        exit 0
      fi
      printf '{"tag":"v1.2.3","object":{"type":"commit","sha":"0123456789abcdef0123456789abcdef01234567"},"verification":{"verified":true,"reason":"valid"}}\\n'
      exit 0
      ;;
  esac
  calls=0
  if [ -f "$FAKE_GH_COUNT" ]; then calls=$(cat "$FAKE_GH_COUNT"); fi
  calls=$((calls + 1))
  printf '%s' "$calls" > "$FAKE_GH_COUNT"
  if [ "$calls" -eq 1 ]; then
    case "$FAKE_GH_SCENARIO" in
      not-found)
        printf '{"message":"simulated"}\\n'
        printf 'gh: Not Found (HTTP 404)\\n' >&2
        exit 1
        ;;
      server-error)
        printf '{"message":"simulated"}\\n'
        printf 'gh: Server Error (HTTP 500)\\n' >&2
        exit 1
        ;;
      owned-draft)
        printf '{"tag_name":"v1.2.3","draft":true,"prerelease":false,"immutable":false,"author":{"login":"github-actions[bot]"},"assets":[]}\\n'
        exit 0
        ;;
      foreign-draft)
        printf '{"tag_name":"v1.2.3","draft":true,"prerelease":false,"immutable":false,"author":{"login":"someone"},"assets":[]}\\n'
        exit 0
        ;;
      mutable)
        printf '{"tag_name":"v1.2.3","draft":false,"prerelease":false,"immutable":false,"assets":[]}\\n'
        exit 0
        ;;
      immutable)
        printf '{"tag_name":"v1.2.3","draft":false,"prerelease":false,"immutable":true,"assets":[]}\\n'
        exit 0
        ;;
    esac
  fi
  printf '{"tag_name":"v1.2.3","draft":false,"prerelease":false,"immutable":true,"assets":[]}\\n'
  exit 0
fi
exit 0
`;
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);
  return { root, bin, log, count, bundle };
}

function run(data, scenario, immutableAcknowledgement = "true") {
  return spawnSync("/bin/bash", [publishScript, "v1.2.3", data.bundle], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: data.bin + ":" + process.env.PATH,
      FAKE_GH_LOG: data.log,
      FAKE_GH_COUNT: data.count,
      FAKE_GH_SCENARIO: scenario,
      GITHUB_REPOSITORY: "necofuryai/depatrol",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      IMMUTABLE_RELEASES_ENABLED: immutableAcknowledgement,
    },
  });
}

test("creates a release after an expected 404 without deleting it", () => {
  const data = fixture();
  try {
    const result = run(data, "not-found");
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(data.log, "utf8");
    assert.match(log, /release create v1\.2\.3/);
    assert.doesNotMatch(log, /release delete/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("fails closed when release inspection returns a server error", () => {
  const data = fixture();
  try {
    const result = run(data, "server-error");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to inspect/);
    const log = readFileSync(data.log, "utf8");
    assert.doesNotMatch(log, /release create/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("replaces only a draft owned by GitHub Actions", () => {
  const data = fixture();
  try {
    const result = run(data, "owned-draft");
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(data.log, "utf8");
    assert.match(log, /release delete v1\.2\.3/);
    assert.match(log, /release create v1\.2\.3/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("refuses to replace a draft owned by another actor", () => {
  const data = fixture();
  try {
    const result = run(data, "foreign-draft");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /another actor/);
    const log = readFileSync(data.log, "utf8");
    assert.doesNotMatch(log, /release delete|release create/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("refuses to repair a published mutable release", () => {
  const data = fixture();
  try {
    const result = run(data, "mutable");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /published release is mutable/);
    const log = readFileSync(data.log, "utf8");
    assert.doesNotMatch(log, /release delete|release create/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("accepts an already-published immutable release", () => {
  const data = fixture();
  try {
    const result = run(data, "immutable", "");
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(data.log, "utf8");
    assert.match(log, /release verify v1\.2\.3/);
    assert.doesNotMatch(log, /release delete|release create/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("requires immutable rollout acknowledgement before creating a release", () => {
  const data = fixture();
  try {
    const result = run(data, "not-found", "");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rollout has not been acknowledged/);
    const log = readFileSync(data.log, "utf8");
    assert.doesNotMatch(log, /release delete|release create/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("fails before release inspection when the remote tag moved", () => {
  const data = fixture();
  try {
    const result = run(data, "remote-moved");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GitHub tag verification failed/);
    const log = readFileSync(data.log, "utf8");
    assert.doesNotMatch(log, /releases\/tags|release delete|release create/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
