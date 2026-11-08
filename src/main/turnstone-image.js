// The one Turnstone image each desktop release ships (ADR-03), pinned by the registry's index digest rather than a
// tag, so a tag moved after the release cannot change what a first run pulls (threat D-2). 1.9.1 for now: a
// known-stable release, which also lets every fresh install exercise the updater (Joe, 2026-11-07). The README's
// Releases section gives the step that moves the pin; newer releases otherwise come only through the updater.
//
// No electron require: fake-podman.js and the tests read it too.

const TURNSTONE_IMAGE = Object.freeze({
  repository: "ghcr.io/turnstonelabs/turnstone",
  version: "1.9.1",
  digest: "sha256:c98762f1c339986d84c255476d0fe188466bb13da1ccee695612ec3a83660d12",
});

/** The reference a pull uses: the repository at the pinned digest, never a tag. */
function pinnedImageRef(image = TURNSTONE_IMAGE) {
  return `${image.repository}@${image.digest}`;
}

module.exports = { TURNSTONE_IMAGE, pinnedImageRef };
