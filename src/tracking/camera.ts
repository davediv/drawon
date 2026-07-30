import { CAMERA } from '../config';

const METADATA_TIMEOUT_MS = 15_000;

export class CameraError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = 'CameraError';
  }
}

function describe(error: unknown): CameraError {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError(
        'Camera access was blocked',
        'Allow the camera for this site in your browser settings, then start it again.',
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError(
        'No camera found',
        'Connect a webcam, or pick a different device below.',
      );
    case 'NotReadableError':
      return new CameraError(
        'The camera is in use',
        'Another app has the camera open. Close it and start again.',
      );
    default:
      return new CameraError(
        'The camera could not start',
        error instanceof Error ? error.message : 'Unknown error.',
      );
  }
}

export class Camera {
  private stream: MediaStream | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  get active(): boolean {
    return this.stream !== null;
  }

  get label(): string {
    return this.stream?.getVideoTracks()[0]?.label ?? '';
  }

  get settings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null;
  }

  async start(deviceId?: string): Promise<void> {
    if (!window.isSecureContext) {
      throw new CameraError(
        'Camera access needs a secure context',
        'Open the app over https, or on http://localhost.',
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError(
        'This browser cannot capture video',
        'Use a recent version of Chrome, Edge, Safari or Firefox.',
      );
    }

    this.stop();

    const constraints: MediaStreamConstraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId }, frameRate: { ideal: CAMERA.idealFrameRate } }
        : {
            facingMode: 'user',
            width: { ideal: CAMERA.idealWidth },
            height: { ideal: CAMERA.idealHeight },
            frameRate: { ideal: CAMERA.idealFrameRate },
          },
    };

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (error) {
      throw describe(error);
    }

    this.stream = stream;
    this.video.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new CameraError('The video stream failed', 'Try starting the camera again.'));
      };
      const cleanup = (): void => {
        window.clearTimeout(timer);
        this.video.removeEventListener('loadedmetadata', onReady);
        this.video.removeEventListener('error', onError);
      };

      // A camera that opens but never delivers a frame would otherwise leave the
      // app waiting forever with no way back.
      const timer = window.setTimeout(() => {
        cleanup();
        reject(
          new CameraError(
            'The camera never sent a frame',
            'It opened but stayed silent. Unplug and reconnect it, or pick another camera.',
          ),
        );
      }, METADATA_TIMEOUT_MS);

      if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        cleanup();
        resolve();
        return;
      }
      this.video.addEventListener('loadedmetadata', onReady, { once: true });
      this.video.addEventListener('error', onError, { once: true });
    });

    await this.video.play();
  }

  /** Device labels are empty until permission has been granted at least once. */
  async listCameras(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
