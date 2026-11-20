// The YouTube IFrame API, which this page loads from youtube.com when a playlist is played.
interface YtPlayer {
  setVolume(level: number): void;
  stopVideo(): void;
  destroy(): void;
}

interface YtPlayerVars {
  autoplay: 1;
  listType?: string;
  list?: string;
}

interface YtApi {
  Player: new (id: string, options: { videoId: string; playerVars: YtPlayerVars }) => YtPlayer;
}

interface Window {
  YT?: YtApi;
  onYouTubeIframeAPIReady?: () => void;
}
