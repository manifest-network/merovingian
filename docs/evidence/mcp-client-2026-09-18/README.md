# Archived discovery client source

These four files are the exact client sources used for the single supervised test on 2026-09-18. They are stored with `.txt` suffixes to make their purpose inspection, not execution. Their SHA-256 digests match the original test artifacts and are listed in [the public evidence bundle](../mcp-discovery-2026-09-18.json).

The sources show endpoint derivation, request restrictions, disabled reconnection retries, and marker-before-call program order. The marker write did not use `fsync`; neither these scripts nor their millisecond timestamps demonstrate crash-safe durability. The original one-visit authorization has already been consumed. Do not restore executable filenames or run these clients against production without a new, recorded approval for that specific visit.

The recorded SDK version was `@modelcontextprotocol/sdk` 1.30.0. Inputs and observed responses are embedded in the evidence bundle; scratch-only filenames in that record describe original local provenance, not additional downloadable artifacts. The scripts are historical evidence, not a maintained release or test command.
