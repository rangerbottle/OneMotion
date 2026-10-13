# Generated video fixtures

`npm test` runs `tests/generate-fixtures.mjs` before Playwright. Install FFmpeg
with the VP8/libvpx encoder, or set `FFMPEG_PATH` to its executable. No third-party
footage is downloaded. Two original color fields are encoded at the dimensions,
frame intervals and durations used by the synthetic API fixtures.

Generated `.webm` files and their hash stamp are ignored by Git and excluded
from the GitHub source package. The generator preserves explicit millisecond
timestamps for the two variable-frame-rate cases. JSON pose/report fixtures
remain source-controlled. After deleting video outputs, `npm test` regenerates
them; `npm run fixtures` generates them without running tests.
