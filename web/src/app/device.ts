export type Device = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'other';

export type Computer = Extract<Device, 'windows' | 'macos' | 'linux'>;
export type Phone = Extract<Device, 'android' | 'ios'>;

/** The system this browser runs on. iPadOS reports itself as a Mac with a touch screen. */
export function detect(): Device {
  const agent = navigator.userAgent;

  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) {
    return 'ios';
  }

  if (/Android/.test(agent)) {
    return 'android';
  }

  if (/Windows/.test(agent)) {
    return 'windows';
  }

  if (/Macintosh|Mac OS X/.test(agent)) {
    return 'macos';
  }

  return /Linux|X11|CrOS/.test(agent) ? 'linux' : 'other';
}

export const isComputer = (device: string): device is Computer =>
  device === 'windows' || device === 'macos' || device === 'linux';

export const isPhone = (device: string): device is Phone => device === 'android' || device === 'ios';
