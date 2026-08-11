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
  const state = join(root, "release-state");
  const bundle = join(root, "bundle");
  mkdirSync(bin);
  mkdirSync(bundle);

  writeFileSync(
    join(bundle, "release-manifest.json"),
    '{"assets":[]}\n',
  );
  writeFileSync(join(bundle, "release-notes.md"), "## Changes\n");

  writeFileSync(
    join(bin, "node"),
    `#!/bin/sh
set -eu
if [ "\${2:-}" = verify-release ]; then
  expected=false
  if [ "\${5:-published}" = draft ]; then expected=true; fi
  actual=$(jq -r '.draft' "$4")
  if [ "$actual" != "$expected" ]; then
    printf 'fake verifier: expected draft=%s, got %s\\n' "$expected" "$actual" >&2
    exit 1
  fi
fi
exit 0
`,
  );
  chmodSync(join(bin, "node"), 0o755);

  const fakeGh = `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
state=$(cat "$FAKE_GH_STATE")

bot_draft='{"id":101,"tag_name":"v1.2.3","draft":true,"prerelease":false,"immutable":false,"author":{"login":"github-actions[bot]"},"assets":[]}'
foreign_draft='{"id":102,"tag_name":"v1.2.3","draft":true,"prerelease":false,"immutable":false,"author":{"login":"someone"},"assets":[]}'
mutable_release='{"id":101,"tag_name":"v1.2.3","draft":false,"prerelease":false,"immutable":false,"author":{"login":"github-actions[bot]"},"assets":[]}'
immutable_release='{"id":101,"tag_name":"v1.2.3","draft":false,"prerelease":false,"immutable":true,"author":{"login":"github-actions[bot]"},"assets":[]}'

print_release() {
  case "$state" in
    draft) printf '%s\\n' "$bot_draft" ;;
    foreign-draft) printf '%s\\n' "$foreign_draft" ;;
    mutable) printf '%s\\n' "$mutable_release" ;;
    immutable) printf '%s\\n' "$immutable_release" ;;
    *) return 1 ;;
  esac
}

if [ "$1" = api ]; then
  shift
  method=GET
  endpoint=
  paginate=false
  slurp=false
  draft_false=false
  make_latest=false
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --method|-X)
        shift
        method=$1
        ;;
      --paginate)
        paginate=true
        ;;
      --slurp)
        slurp=true
        ;;
      -F)
        shift
        if [ "$1" = draft=false ]; then draft_false=true; fi
        ;;
      -f)
        shift
        if [ "$1" = make_latest=true ]; then make_latest=true; fi
        ;;
      repos/*)
        endpoint=$1
        ;;
    esac
    shift
  done

  case "$endpoint" in
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
    *"/releases?per_page=100")
      if [ "$paginate" != true ] || [ "$slurp" != true ]; then
        printf 'fake gh: release listing must paginate and slurp\\n' >&2
        exit 1
      fi
      if [ "$FAKE_GH_SCENARIO" = server-error ]; then
        printf 'gh: Server Error (HTTP 500)\\n' >&2
        exit 1
      fi
      if [ "$FAKE_GH_SCENARIO" = empty-outer ]; then
        printf '[]\\n'
        exit 0
      fi
      if [ "$FAKE_GH_SCENARIO" = malformed-entry ]; then
        printf '[[null]]\\n'
        exit 0
      fi
      if [ "$FAKE_GH_SCENARIO" = duplicate ]; then
        printf '[[%s,%s]]\\n' "$bot_draft" "$foreign_draft"
        exit 0
      fi
      if [ "$FAKE_GH_SCENARIO" = post-create-missing ] && [ "$state" = draft ]; then
        printf '[[]]\\n'
        exit 0
      fi
      if [ "$FAKE_GH_SCENARIO" = second-page-draft ]; then
        if release=$(print_release); then
          printf '[[],[%s]]\\n' "$release"
        else
          printf '[[],[]]\\n'
        fi
        exit 0
      fi
      if release=$(print_release); then
        printf '[[%s]]\\n' "$release"
      else
        printf '[[]]\\n'
      fi
      exit 0
      ;;
    */releases/tags/*)
      case "$state" in
        immutable) printf '%s\\n' "$immutable_release" ;;
        mutable) printf '%s\\n' "$mutable_release" ;;
        *)
          printf 'gh: Not Found (HTTP 404)\\n' >&2
          exit 1
          ;;
      esac
      exit 0
      ;;
    */releases/[0-9]*)
      release_id=\${endpoint##*/}
      if [ "$release_id" != 101 ]; then
        printf 'gh: Not Found (HTTP 404)\\n' >&2
        exit 1
      fi
      case "$method" in
        GET)
          if release=$(print_release); then
            printf '%s\\n' "$release"
            exit 0
          fi
          printf 'gh: Not Found (HTTP 404)\\n' >&2
          exit 1
          ;;
        DELETE)
          if [ "$state" != draft ]; then
            printf 'fake gh: refusing to delete non-draft release\\n' >&2
            exit 1
          fi
          printf 'missing\\n' > "$FAKE_GH_STATE"
          exit 0
          ;;
        PATCH)
          if [ "$state" != draft ]; then
            printf 'fake gh: refusing to publish non-draft release\\n' >&2
            exit 1
          fi
          if [ "$draft_false" != true ] || [ "$make_latest" != true ]; then
            printf 'fake gh: publish must clear draft and mark latest\\n' >&2
            exit 1
          fi
          if [ "$FAKE_GH_SCENARIO" = publish-mutable ]; then
            printf 'mutable\\n' > "$FAKE_GH_STATE"
          else
            printf 'immutable\\n' > "$FAKE_GH_STATE"
          fi
          exit 0
          ;;
      esac
      ;;
  esac
  printf 'fake gh: unexpected api request: %s %s\\n' "$method" "$endpoint" >&2
  exit 1
fi

if [ "$1" = release ] && [ "$2" = create ]; then
  if [ "$state" != missing ]; then
    printf 'fake gh: release already exists\\n' >&2
    exit 1
  fi
  printf 'draft\\n' > "$FAKE_GH_STATE"
  printf 'https://github.com/necofuryai/depatrol/releases/tag/untagged-fake\\n'
  exit 0
fi

if [ "$1" = release ] && [ "$2" = upload ]; then
  [ "$state" = draft ]
  exit 0
fi

if [ "$1" = release ] && [ "$2" = verify ]; then
  [ "$state" = immutable ]
  exit 0
fi

printf 'fake gh: unexpected command: %s\\n' "$*" >&2
exit 1
`;
  writeFileSync(join(bin, "gh"), fakeGh);
  chmodSync(join(bin, "gh"), 0o755);
  return { root, bin, log, state, bundle };
}

function run(data, scenario, immutableAcknowledgement = "true") {
  const initialState = {
    "owned-draft": "draft",
    "second-page-draft": "draft",
    "foreign-draft": "foreign-draft",
    mutable: "mutable",
    immutable: "immutable",
  }[scenario] ?? "missing";
  writeFileSync(data.state, initialState + "\n");
  return spawnSync("/bin/bash", [publishScript, "v1.2.3", data.bundle], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: data.bin + ":" + process.env.PATH,
      FAKE_GH_LOG: data.log,
      FAKE_GH_STATE: data.state,
      FAKE_GH_SCENARIO: scenario,
      GITHUB_REPOSITORY: "necofuryai/depatrol",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      IMMUTABLE_RELEASES_ENABLED: immutableAcknowledgement,
    },
  });
}

function assertNoReleaseMutation(log) {
  assert.doesNotMatch(
    log,
    /api --method (?:DELETE|PATCH) repos\/necofuryai\/depatrol\/releases\/|release (?:create|upload)/,
  );
}

test("publishes a new draft without reading it from the published tag endpoint", () => {
  const data = fixture();
  try {
    const result = run(data, "not-found");
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(data.log, "utf8");
    assert.match(log, /release create v1\.2\.3/);
    assert.match(
      log,
      /api --paginate --slurp repos\/necofuryai\/depatrol\/releases\?per_page=100/,
    );
    assert.match(log, /api --method PATCH repos\/necofuryai\/depatrol\/releases\/101/);
    assert.match(log, /release upload v1\.2\.3 .*release-manifest\.json/);
    assert.match(log, /release verify v1\.2\.3/);
    assert.doesNotMatch(log, /api --method DELETE/);
    assert.ok(
      log.indexOf("api repos/necofuryai/depatrol/releases/tags/v1.2.3") >
        log.indexOf("api --method PATCH repos/necofuryai/depatrol/releases/101"),
      log,
    );
    assert.ok(
      log.indexOf("release upload v1.2.3") <
        log.indexOf("api --method PATCH repos/necofuryai/depatrol/releases/101"),
      log,
    );
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
    assert.match(
      log,
      /api --method DELETE repos\/necofuryai\/depatrol\/releases\/101/,
    );
    assert.match(log, /release create v1\.2\.3/);
    assert.doesNotMatch(log, /release delete/);
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
    assertNoReleaseMutation(log);
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
    assertNoReleaseMutation(log);
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
    assertNoReleaseMutation(log);
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
    assertNoReleaseMutation(log);
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
    assert.doesNotMatch(log, /releases\?per_page|releases\/tags/);
    assertNoReleaseMutation(log);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("fails closed when multiple releases use the same tag", () => {
  const data = fixture();
  try {
    const result = run(data, "duplicate");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /multiple releases match tag/);
    const log = readFileSync(data.log, "utf8");
    assertNoReleaseMutation(log);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("finds an owned draft on a later release page", () => {
  const data = fixture();
  try {
    const result = run(data, "second-page-draft");
    assert.equal(result.status, 0, result.stderr);
    const log = readFileSync(data.log, "utf8");
    assert.match(
      log,
      /api --method DELETE repos\/necofuryai\/depatrol\/releases\/101/,
    );
    assert.match(log, /release verify v1\.2\.3/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

for (const scenario of ["empty-outer", "malformed-entry"]) {
  test(`fails closed for malformed release listing: ${scenario}`, () => {
    const data = fixture();
    try {
      const result = run(data, scenario);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /unexpected releases response/);
      const log = readFileSync(data.log, "utf8");
      assertNoReleaseMutation(log);
    } finally {
      rmSync(data.root, { recursive: true, force: true });
    }
  });
}

test("stops when a newly-created draft cannot be located", () => {
  const data = fixture();
  try {
    const result = run(data, "post-create-missing");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /failed to locate the created draft/);
    const log = readFileSync(data.log, "utf8");
    assert.match(log, /release create v1\.2\.3/);
    assert.doesNotMatch(log, /release upload|api --method PATCH|release verify/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test("stops when GitHub publishes the release as mutable", () => {
  const data = fixture();
  try {
    const result = run(data, "publish-mutable");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /published release is mutable/);
    const log = readFileSync(data.log, "utf8");
    assert.match(
      log,
      /api --method PATCH repos\/necofuryai\/depatrol\/releases\/101/,
    );
    assert.doesNotMatch(log, /release verify/);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});
