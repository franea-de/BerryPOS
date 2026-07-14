/** Minimal typings for the Shape Detection API (Chrome/Android). */
interface DetectedBarcode {
  rawValue: string;
  format: string;
}

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  static getSupportedFormats(): Promise<string[]>;
  detect(source: CanvasImageSource | HTMLVideoElement): Promise<DetectedBarcode[]>;
}
