const media = {
  name: "media",
  description: "Search for and play videos on YouTube, control video playback (play, pause, skip, volume), search for music on Spotify, control Spotify playback, or interact with any media streaming site",

  systemPromptAddition: `
MEDIA SKILL ACTIVE.
YouTube patterns:
- Search: click the search bar at top, type query, press Enter. Then click a result.
- Play/Pause: click the video player area or the play/pause button in controls.
- Skip: click the "Next" button or press keypress with key "N".
- Volume: click the volume slider — it requires a click at the right position.
- Full screen: keypress with key "f".
- Seek: keypress ArrowRight (5s forward) or ArrowLeft (5s back).

Spotify patterns:
- Search: click the Search icon in sidebar, then click search input, type query.
- Play: click the green Play button on a track/album/playlist.
- Pause: click the Pause button in the bottom playback bar.
- Next track: click the Next button (⏭) in bottom bar.
- Volume: slider in bottom-right corner.

Always extract { title, artist, duration } from the currently playing media when done.
`.trim(),

  preFlight: async () => ({}),
  cdpHints: {},
  postTeardown: async () => {}
};

export default media;
