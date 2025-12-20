export interface AnalysisResult {
  description?: string;
  points?: string[]; // For the 1, 2, 3 bullet points
}

export interface EditResult {
  imageData?: string; // Base64
  textResponse?: string;
}

export enum AppState {
  IDLE = 'IDLE',
  RECORDING = 'RECORDING', // New state for video recording
  ANALYZING = 'ANALYZING',
  VIEWING = 'VIEWING',
  EDITING = 'EDITING',
  ERROR = 'ERROR'
}

export enum CaptureMode {
  PHOTO = 'PHOTO',
  VIDEO = 'VIDEO'
}

export interface ImageFile {
  id: string; // Unique ID for history
  preview: string; // Base64 for display
  raw: string; // Base64 for API (no header)
  mimeType: string;
  timestamp: number;
  type: 'image' | 'video';
  analysis?: AnalysisResult;
}

export type HistoryItem = ImageFile;