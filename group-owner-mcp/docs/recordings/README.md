# Recordings — group-owner-mcp

Backup demo artifacts. **For a presentation, use the `.mp4` files** — standard H.264
video that drops straight into Keynote / PowerPoint / Google Slides and plays in any
video player. `.webm`, `.gif`, and browser-playable `.svg` versions are also provided.

## Videos (use these to present)

| File | What it shows | Length |
|------|---------------|--------|
| `red-team.mp4` | **Presentation reel** — opens with a flash card listing all 11 tests, reveals each result one-by-one, and holds on the green **11 pass / 0 fail**. 7 social-engineering attacks denied, 3 owner happy-path controls, 1 structural guarantee. | ~21s |
| `tools-in-use.mp4` | Alice (a normal employee, **no admin role**) uses the three tools to manage the two groups she owns — list, view members, add, remove — then is **denied** on a group she doesn't own. | ~24s |

Each also has a `.webm` (VP9) and a silently-looping `.gif` version.

## Other formats

| File | What it is | How to view |
|------|------------|-------------|
| `*.svg` | Self-contained animated terminal recordings. | Download the raw file and open in a browser (GitHub's file view won't animate it) |
| `red-team.cast` / `tools-in-use.cast` | Raw [asciinema](https://asciinema.org) recordings of the actual suite/demo run. | `asciinema play red-team.cast` |
| `red-team-reel.cast` | asciinema source for the polished `red-team.mp4` presentation reel. | `asciinema play red-team-reel.cast` |
| `*.txt` | Plain-text transcripts (ANSI). | any pager / `cat` |

> Note: `red-team.svg` / `red-team.cast` / `red-team.txt` capture the **raw** suite run (fast);
> `red-team.mp4` / `.webm` / `.gif` are the **polished presentation reel** built from `red-team-reel.cast`.

## Reproduce them yourself

```bash
cd environments/ai-agent-demo/group-owner-mcp
npm install

# Tools-in-use walkthrough (deterministic in-memory fixture — no live Okta needed):
npx tsx scripts/demo.ts

# Red-team suite:
npm test
# or a prettier reporter (used for the recording):
npx tsx --test --test-reporter=spec test/red-team.test.ts
```

Both run fully offline: the Okta HTTP client is swapped for an in-memory fixture, so
the recordings are deterministic and safe to replay anywhere. Enforcement in the
recordings is **Layer 2 (Okta ownership, FGA off)** — proving the guarantee holds with
no FGA. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the full enforcement model.
