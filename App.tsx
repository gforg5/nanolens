import React, { useState, useRef, useEffect } from 'react';
import { Camera, Upload, Sparkles, Send, X, Download, RotateCcw, Image as ImageIcon, Video, History, ChevronLeft, Trash2, Share2, FileText, User, Github, Linkedin, Code, ZoomIn } from 'lucide-react';
import { jsPDF } from "jspdf";
import { analyzeImage, editImage, analyzeVideo } from './services/geminiService';
import { AppState, ImageFile, EditResult, CaptureMode, HistoryItem } from './types';
import { Button } from './components/Button';
import { LoadingOverlay } from './components/LoadingOverlay';

// Helper to convert file/blob to base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
};

export default function App() {
  // Application State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [captureMode, setCaptureMode] = useState<CaptureMode>(CaptureMode.PHOTO);
  
  // Data State
  const [currentFile, setCurrentFile] = useState<ImageFile | null>(null);
  const [editPrompt, setEditPrompt] = useState("");
  const [editedImage, setEditedImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showDeveloper, setShowDeveloper] = useState(false);
  
  // Camera & Recording State
  const [cameraError, setCameraError] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  
  // Zoom State
  const [zoom, setZoom] = useState(1);
  const [maxZoom, setMaxZoom] = useState(1);
  const [supportsZoom, setSupportsZoom] = useState(false);

  // Refs
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoTrackRef = useRef<MediaStreamTrack | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  // Load history on mount
  useEffect(() => {
    const saved = localStorage.getItem('nanoLensHistory');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to load history", e);
      }
    }
  }, []);

  // Save history on change
  useEffect(() => {
    localStorage.setItem('nanoLensHistory', JSON.stringify(history));
  }, [history]);

  // Camera Management
  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      if (appState !== AppState.IDLE && appState !== AppState.RECORDING) return;

      try {
        setCameraError(false);
        stream = await navigator.mediaDevices.getUserMedia({
          video: { 
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            // @ts-ignore
            zoom: true 
          },
          audio: captureMode === CaptureMode.VIDEO 
        });

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        const track = stream.getVideoTracks()[0];
        videoTrackRef.current = track;
        
        // @ts-ignore
        if (track.getCapabilities) {
           // @ts-ignore
           const capabilities: any = track.getCapabilities();
           if (capabilities && 'zoom' in capabilities) {
             setSupportsZoom(true);
             setMaxZoom(capabilities.zoom.max);
             setZoom(capabilities.zoom.min || 1);
           }
        }

      } catch (err) {
        console.error("Failed to access camera:", err);
        setCameraError(true);
      }
    };

    if (appState === AppState.IDLE) {
      startCamera();
    } else {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (videoTrackRef.current) {
        videoTrackRef.current.stop();
      }
    }

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (videoTrackRef.current) {
        videoTrackRef.current.stop();
      }
    };
  }, [appState, captureMode]);

  const handleZoomChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newZoom = parseFloat(e.target.value);
    setZoom(newZoom);
    
    if (videoTrackRef.current) {
      try {
        // @ts-ignore
        await videoTrackRef.current.applyConstraints({
          advanced: [{ zoom: newZoom }]
        });
      } catch (err) {
        console.warn("Zoom not supported directly:", err);
      }
    }
  };

  const handleCapture = async () => {
    if (captureMode === CaptureMode.PHOTO) {
      capturePhoto();
    } else {
      if (appState === AppState.IDLE) {
        startRecording();
      } else if (appState === AppState.RECORDING) {
        stopRecording();
      }
    }
  };

  const capturePhoto = async () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0);
    
    const base64String = canvas.toDataURL('image/jpeg', 0.9);
    const rawBase64 = base64String.split(',')[1];

    const newFile: ImageFile = {
      id: Date.now().toString(),
      preview: base64String,
      raw: rawBase64,
      mimeType: 'image/jpeg',
      timestamp: Date.now(),
      type: 'image'
    };

    setCurrentFile(newFile);
    await performAnalysis(newFile);
  };

  const startRecording = () => {
    if (!videoRef.current || !videoRef.current.srcObject) return;
    
    const stream = videoRef.current.srcObject as MediaStream;
    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      const base64String = await blobToBase64(blob);
      const rawBase64 = base64String.split(',')[1];

      const newFile: ImageFile = {
        id: Date.now().toString(),
        preview: base64String,
        raw: rawBase64,
        mimeType: 'video/webm',
        timestamp: Date.now(),
        type: 'video'
      };

      setCurrentFile(newFile);
      setAppState(AppState.ANALYZING);
      
      try {
        const result = await analyzeVideo(newFile.raw, newFile.mimeType);
        const fileWithAnalysis = { ...newFile, analysis: result };
        setCurrentFile(fileWithAnalysis);
        addToHistory(fileWithAnalysis);
        setAppState(AppState.VIEWING);
      } catch (err) {
        setError("Video analysis failed.");
        setAppState(AppState.VIEWING);
      }
    };

    mediaRecorderRef.current = recorder;
    recorder.start();
    setAppState(AppState.RECORDING);
    
    setRecordingTime(0);
    timerRef.current = window.setInterval(() => {
      setRecordingTime(t => t + 1);
    }, 1000);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && appState === AppState.RECORDING) {
      mediaRecorderRef.current.stop();
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setEditedImage(null);
    setEditPrompt("");
    setError(null);
    
    try {
      const base64String = await blobToBase64(file);
      const rawBase64 = base64String.split(',')[1];
      const isVideo = file.type.startsWith('video');
      
      const newFile: ImageFile = {
        id: Date.now().toString(),
        preview: base64String,
        raw: rawBase64,
        mimeType: file.type,
        timestamp: Date.now(),
        type: isVideo ? 'video' : 'image'
      };

      setCurrentFile(newFile);
      
      if (isVideo) {
         setAppState(AppState.ANALYZING);
         const result = await analyzeVideo(newFile.raw, newFile.mimeType);
         const fileWithAnalysis = { ...newFile, analysis: result };
         setCurrentFile(fileWithAnalysis);
         addToHistory(fileWithAnalysis);
         setAppState(AppState.VIEWING);
      } else {
         await performAnalysis(newFile);
      }

    } catch (err) {
      console.error(err);
      setError("Failed to process file.");
      setAppState(AppState.IDLE);
    }
  };

  const performAnalysis = async (file: ImageFile) => {
    setAppState(AppState.ANALYZING);
    try {
      const result = await analyzeImage(file.raw, file.mimeType);
      const fileWithAnalysis = { ...file, analysis: result };
      setCurrentFile(fileWithAnalysis);
      addToHistory(fileWithAnalysis);
      setAppState(AppState.VIEWING);
    } catch (err) {
      console.error(err);
      setError("Could not analyze image.");
      setAppState(AppState.VIEWING);
    }
  };

  const addToHistory = (item: HistoryItem) => {
    setHistory(prev => [item, ...prev].slice(0, 50)); 
  };

  const deleteHistoryItem = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setHistory(prev => prev.filter(i => i.id !== id));
  };

  const restoreHistoryItem = (item: HistoryItem) => {
    setCurrentFile(item);
    setEditedImage(null);
    setEditPrompt("");
    setShowHistory(false);
    setAppState(AppState.VIEWING);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentFile || !editPrompt.trim() || currentFile.type === 'video') return;

    setAppState(AppState.EDITING);
    setError(null);

    try {
      const sourceImageRaw = editedImage ? editedImage.split(',')[1] : currentFile.raw;
      const result: EditResult = await editImage(sourceImageRaw, "image/png", editPrompt);

      if (result.imageData) {
        setEditedImage(`data:image/png;base64,${result.imageData}`);
        setEditPrompt("");
      } else if (result.textResponse) {
        setError(result.textResponse);
      } else {
        setError("No changes generated.");
      }
    } catch (err) {
      setError("Failed to edit image.");
    } finally {
      setAppState(AppState.VIEWING);
    }
  };

  const exportToPDF = () => {
    if (!currentFile) return;
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFontSize(22);
    doc.setTextColor(40, 40, 40);
    doc.text("Nano Lens Analysis", 20, 20);
    doc.setFontSize(10);
    doc.setTextColor(100, 100, 100);
    doc.text(`Generated on ${new Date().toLocaleString()}`, 20, 30);
    try {
      const imgProps = doc.getImageProperties(editedImage || currentFile.preview);
      const margin = 20;
      const maxImgWidth = pageWidth - (margin * 2);
      const imgHeight = (imgProps.height * maxImgWidth) / imgProps.width;
      const finalHeight = Math.min(imgHeight, 150);
      doc.addImage(editedImage || currentFile.preview, 'JPEG', margin, 40, maxImgWidth, finalHeight);
      let yPos = 40 + finalHeight + 20;
      doc.setFontSize(16);
      doc.setTextColor(0, 0, 0);
      doc.text("Insights", margin, yPos);
      yPos += 10;
      doc.setFontSize(12);
      doc.setTextColor(60, 60, 60);
      const points = currentFile.analysis?.points || ["No analysis available."];
      points.forEach((point, i) => {
        const text = `${i + 1}. ${point}`;
        const splitText = doc.splitTextToSize(text, maxImgWidth);
        doc.text(splitText, margin, yPos);
        yPos += (splitText.length * 7) + 5;
      });
      doc.save("nano-lens-report.pdf");
    } catch (e) {
      setError("Could not generate PDF.");
    }
  };

  const shareContent = async () => {
    if (!currentFile) return;
    const text = currentFile.analysis?.points?.join('\n\n') || "Check out this analysis from Nano Lens!";
    if (navigator.share) {
      try {
        const blob = await (await fetch(editedImage || currentFile.preview)).blob();
        const file = new File([blob], "nano-lens-capture.jpg", { type: blob.type });
        await navigator.share({ title: 'Nano Lens Analysis', text: text, files: [file] });
      } catch (err) {
        try {
           await navigator.share({ title: 'Nano Lens Analysis', text: text });
        } catch (e) {}
      }
    } else {
      navigator.clipboard.writeText(text);
      setError("Analysis copied to clipboard!");
      setTimeout(() => setError(null), 2000);
    }
  };

  const resetApp = () => {
    setCurrentFile(null);
    setEditedImage(null);
    setEditPrompt("");
    setAppState(AppState.IDLE);
    setRecordingTime(0);
    setZoom(1);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden relative selection:bg-indigo-500 selection:text-white">
      <input type="file" accept="image/*,video/*" ref={fileInputRef} className="hidden" onChange={handleFileSelect} />

      {appState === AppState.ANALYZING && <LoadingOverlay message="Analyzing Reality..." />}
      {appState === AppState.EDITING && <LoadingOverlay message="Editing with AI..." />}

      {appState === AppState.IDLE || appState === AppState.RECORDING ? (
        <div className="absolute inset-0 z-0 bg-black flex flex-col">
          {!cameraError ? (
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${appState === AppState.RECORDING ? 'opacity-80' : 'opacity-100'}`}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center space-y-4">
              <div className="w-16 h-16 rounded-full bg-zinc-900 flex items-center justify-center">
                 <Camera className="w-8 h-8 text-zinc-500" />
              </div>
              <p className="text-zinc-400">Camera access needed</p>
              <Button onClick={() => fileInputRef.current?.click()} icon={<Upload className="w-4 h-4" />}>
                Upload Media
              </Button>
            </div>
          )}
          
          {!cameraError && appState === AppState.IDLE && (
            <div className="absolute top-1/2 left-0 right-0 -translate-y-1/2 flex flex-col items-center justify-center pointer-events-none z-10">
              <div className="w-64 h-64 border border-white/20 rounded-3xl mb-4 relative opacity-60">
                <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-white rounded-tl-xl shadow-sm"></div>
                <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-white rounded-tr-xl shadow-sm"></div>
                <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-white rounded-bl-xl shadow-sm"></div>
                <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-white rounded-br-xl shadow-sm"></div>
              </div>
              <p className="text-white text-lg font-medium drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] bg-black/40 px-6 py-2 rounded-full backdrop-blur-md border border-white/10 animate-pulse">
                Scan anything to know
              </p>
            </div>
          )}

          <div className="absolute top-0 left-0 right-0 p-6 z-20 bg-gradient-to-b from-black/90 via-black/50 to-transparent flex flex-col gap-6">
            <div className="flex justify-between items-center w-full">
              <button 
                onClick={() => setShowHistory(true)}
                className="p-3.5 bg-black/40 backdrop-blur-xl rounded-full text-white border border-white/10 hover:bg-zinc-800/60 transition-all active:scale-95 shadow-lg"
              >
                <History className="w-5 h-5" />
              </button>

              <button 
                onClick={() => setShowDeveloper(true)}
                className="flex items-center gap-2 px-4 py-2 bg-black/40 backdrop-blur-xl rounded-full text-xs font-semibold text-white border border-white/10 hover:bg-zinc-800/60 transition-all active:scale-95 shadow-lg tracking-wide uppercase"
              >
                <User className="w-3.5 h-3.5 text-indigo-400" />
                <span>Mohsin</span>
              </button>

              <button 
                onClick={() => fileInputRef.current?.click()}
                className="p-3.5 bg-black/40 backdrop-blur-xl rounded-full text-white border border-white/10 hover:bg-zinc-800/60 transition-all active:scale-95 shadow-lg"
              >
                <ImageIcon className="w-5 h-5" />
              </button>
            </div>
            
            <div className="self-center flex bg-black/40 backdrop-blur-xl rounded-full p-1.5 border border-white/10 shadow-lg">
              <button
                onClick={() => setCaptureMode(CaptureMode.PHOTO)}
                className={`px-5 py-2 rounded-full text-sm font-bold transition-all duration-300 ${captureMode === CaptureMode.PHOTO ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-400 hover:text-white'}`}
              >
                Photo
              </button>
              <button
                onClick={() => setCaptureMode(CaptureMode.VIDEO)}
                className={`px-5 py-2 rounded-full text-sm font-bold transition-all duration-300 ${captureMode === CaptureMode.VIDEO ? 'bg-indigo-600 text-white shadow-md' : 'text-zinc-400 hover:text-white'}`}
              >
                Video
              </button>
            </div>
            
            {appState === AppState.RECORDING && (
               <div className="self-center flex items-center gap-2 bg-red-500/90 backdrop-blur text-white px-5 py-1.5 rounded-full text-sm font-mono font-bold animate-pulse shadow-red-500/20 shadow-lg">
                 <div className="w-2 h-2 rounded-full bg-white"></div>
                 {formatTime(recordingTime)}
               </div>
            )}
          </div>

          {!cameraError && (
            <div className="absolute bottom-0 left-0 right-0 pb-12 pt-24 flex flex-col justify-end items-center z-20 bg-gradient-to-t from-black/95 via-black/60 to-transparent">
              {supportsZoom && maxZoom > 1 && appState === AppState.IDLE && (
                 <div className="mb-8 w-64 flex items-center gap-3 px-4 py-2 rounded-full bg-black/40 backdrop-blur-md border border-white/10">
                    <ZoomIn className="w-4 h-4 text-zinc-400" />
                    <input 
                      type="range" 
                      min="1" 
                      max={Math.min(maxZoom, 5)} 
                      step="0.1" 
                      value={zoom} 
                      onChange={handleZoomChange}
                      className="w-full h-1 bg-zinc-600 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                    <span className="text-xs font-mono text-zinc-300 w-8 text-right">{zoom.toFixed(1)}x</span>
                 </div>
              )}

              <button 
                onClick={handleCapture}
                className={`group relative h-24 w-24 rounded-full border-[5px] flex items-center justify-center focus:outline-none transition-all active:scale-90 touch-manipulation shadow-2xl
                  ${captureMode === CaptureMode.VIDEO 
                    ? (appState === AppState.RECORDING ? 'border-red-500 bg-red-500/10' : 'border-red-500') 
                    : 'border-white'}`}
              >
                <div className={`transition-all duration-300 shadow-[0_0_30px_rgba(255,255,255,0.2)]
                  ${captureMode === CaptureMode.VIDEO 
                    ? (appState === AppState.RECORDING ? 'h-10 w-10 rounded-md bg-red-500' : 'h-20 w-20 rounded-full bg-red-500') 
                    : 'h-20 w-20 rounded-full bg-white group-hover:scale-95'}`}
                ></div>
              </button>
            </div>
          )}
        </div>
      ) : null}

      {(appState === AppState.VIEWING || appState === AppState.EDITING || appState === AppState.ANALYZING) && currentFile && (
        <div className="flex flex-col h-screen w-full bg-zinc-950 relative z-20 animate-in fade-in slide-in-from-bottom-10 duration-500">
          <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur z-30">
            <button onClick={resetApp} className="flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white transition-all">
              <ChevronLeft className="h-5 w-5" />
              <span className="font-medium text-sm">Camera</span>
            </button>
            
            <div className="flex gap-2">
               <button onClick={shareContent} className="p-2.5 bg-zinc-900 hover:bg-zinc-800 rounded-full text-zinc-300 hover:text-white transition-all" title="Share">
                 <Share2 className="h-4 w-4" />
               </button>
               <button onClick={exportToPDF} className="p-2.5 bg-zinc-900 hover:bg-zinc-800 rounded-full text-zinc-300 hover:text-white transition-all" title="Export PDF">
                 <FileText className="h-4 w-4" />
               </button>
               {editedImage && (
                <>
                  <button onClick={() => setEditedImage(null)} className="p-2.5 bg-zinc-900 hover:bg-zinc-800 rounded-full text-zinc-300 hover:text-white transition-all" title="Undo Edit">
                      <RotateCcw className="h-4 w-4" />
                  </button>
                  <a href={editedImage} download="nano-edit.png" className="p-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-full text-white shadow-lg shadow-indigo-500/20 transition-all" title="Download Image">
                    <Download className="h-4 w-4" />
                  </a>
                </>
               )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto overflow-x-hidden bg-zinc-950 pb-36 custom-scrollbar">
            <div className="w-full bg-black relative shadow-2xl border-b border-zinc-900">
              {currentFile.type === 'video' ? (
                <video src={currentFile.preview} controls className="w-full max-h-[55vh] object-contain mx-auto" />
              ) : (
                <img src={editedImage || currentFile.preview} alt="Result" className="w-full max-h-[55vh] object-contain mx-auto" />
              )}
            </div>

            <div className="p-6 max-w-2xl mx-auto space-y-6">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-indigo-500/10 rounded-lg">
                  <Sparkles className="h-5 w-5 text-indigo-500" />
                </div>
                <h3 className="text-xl font-bold text-white tracking-tight">Smart Insights</h3>
              </div>

              <div className="grid gap-4">
                 {currentFile.analysis?.points?.map((point, index) => (
                   <div key={index} className="group relative flex items-start gap-4 p-5 rounded-2xl bg-zinc-900/40 border border-zinc-800/60 overflow-hidden hover:bg-zinc-900/60 hover:border-indigo-500/30 transition-all duration-300">
                      <div className="relative shrink-0 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20 text-white font-bold text-sm">
                        {index + 1}
                      </div>
                      <p className="relative text-zinc-300 leading-relaxed font-medium">
                        {point}
                      </p>
                   </div>
                 ))}
                 {!currentFile.analysis?.points && (
                   <div className="space-y-4">
                      {[1, 2, 3].map(i => (
                        <div key={i} className="h-24 bg-zinc-900/30 rounded-2xl animate-pulse border border-zinc-800/30"></div>
                      ))}
                   </div>
                 )}
              </div>
              {error && <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm text-center">{error}</div>}
            </div>
          </div>

          {currentFile.type === 'image' && (
            <div className="absolute bottom-0 left-0 right-0 p-5 bg-gradient-to-t from-zinc-950 via-zinc-950 to-transparent z-30">
               <form onSubmit={handleEditSubmit} className="max-w-2xl mx-auto relative">
                  <div className="relative flex items-center bg-zinc-900/90 backdrop-blur-xl rounded-2xl border border-zinc-700/50 focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/50 transition-all overflow-hidden shadow-2xl">
                    <input
                      type="text"
                      value={editPrompt}
                      onChange={(e) => setEditPrompt(e.target.value)}
                      placeholder="Ask AI to edit..."
                      className="w-full bg-transparent border-none text-white pl-5 pr-14 py-4 text-base placeholder-zinc-500 focus:ring-0"
                      disabled={appState === AppState.EDITING}
                    />
                    <button
                      type="submit"
                      disabled={!editPrompt.trim() || appState === AppState.EDITING}
                      className="absolute right-2 p-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:bg-zinc-800 text-white rounded-xl transition-all shadow-lg"
                    >
                       {appState === AppState.EDITING ? <Sparkles className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                    </button>
                  </div>
               </form>
            </div>
          )}
        </div>
      )}

      {showHistory && (
        <div className="absolute inset-0 z-50 flex">
           <div className="absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity" onClick={() => setShowHistory(false)}></div>
           <div className="relative w-full max-w-sm h-full bg-zinc-950 border-r border-zinc-800 flex flex-col shadow-2xl animate-in slide-in-from-left duration-300">
             <div className="flex items-center justify-between p-6 border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-md">
               <h2 className="text-xl font-bold text-white flex items-center gap-3">
                 <History className="h-5 w-5 text-indigo-500" />
                 History
               </h2>
               <button onClick={() => setShowHistory(false)} className="p-2 hover:bg-zinc-900 rounded-lg text-zinc-400 hover:text-white transition-colors">
                 <X className="h-5 w-5" />
               </button>
             </div>
             <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
               {history.length === 0 ? (
                 <div className="flex flex-col items-center justify-center h-64 text-zinc-500 space-y-2">
                   <History className="w-10 h-10 opacity-20" />
                   <p>No captures yet.</p>
                 </div>
               ) : (
                 history.map((item) => (
                   <div key={item.id} onClick={() => restoreHistoryItem(item)} className="flex items-start gap-3 p-3 rounded-xl bg-zinc-900/40 border border-zinc-800 hover:bg-zinc-900 hover:border-indigo-500/30 cursor-pointer transition-all group">
                     <div className="h-16 w-16 bg-black rounded-lg overflow-hidden shrink-0 border border-zinc-800 relative">
                       {item.type === 'video' ? (
                         <div className="w-full h-full flex items-center justify-center bg-zinc-800"><Video className="w-6 h-6 text-zinc-500" /></div>
                       ) : (
                         <img src={item.preview} className="w-full h-full object-cover" alt="thumbnail" />
                       )}
                     </div>
                     <div className="flex-1 min-w-0 py-1">
                       <div className="flex justify-between items-center mb-1">
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${item.type === 'video' ? 'bg-red-500/20 text-red-400' : 'bg-indigo-500/20 text-indigo-400'}`}>{item.type}</span>
                          <span className="text-xs text-zinc-500">{new Date(item.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                       </div>
                       <p className="text-sm text-zinc-300 line-clamp-1 font-medium">{item.analysis?.points?.[0] || "Processing..."}</p>
                     </div>
                     <button onClick={(e) => deleteHistoryItem(item.id, e)} className="p-2 text-zinc-600 hover:text-red-400 hover:bg-red-400/10 rounded-lg opacity-0 group-hover:opacity-100 transition-all">
                       <Trash2 className="h-4 w-4" />
                     </button>
                   </div>
                 ))
               )}
             </div>
           </div>
        </div>
      )}

      {showDeveloper && (
        <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
           <div className="absolute inset-0 bg-black/90 backdrop-blur-md" onClick={() => setShowDeveloper(false)}></div>
           <div className="relative bg-zinc-900/90 border border-zinc-800 rounded-3xl p-8 max-w-sm w-full shadow-2xl flex flex-col items-center text-center animate-in zoom-in-95 duration-200 backdrop-blur-xl">
              <button onClick={() => setShowDeveloper(false)} className="absolute top-4 right-4 text-zinc-400 hover:text-white transition-colors"><X className="w-6 h-6" /></button>
              <div className="relative mb-6 group">
                <div className="absolute -inset-1 bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-full blur opacity-75 group-hover:opacity-100 transition-opacity duration-500"></div>
                <img src="https://images.unsplash.com/photo-1556157382-97eda2d62296?fit=crop&w=300&h=300&q=80" alt="Sayed Mohsin Ali" className="relative w-32 h-32 rounded-full border-4 border-zinc-900 object-cover shadow-2xl" />
              </div>
              <h2 className="text-2xl font-bold text-white mb-1">Sayed Mohsin Ali</h2>
              <p className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-purple-400 font-medium mb-5">Expert Full Stack Web Developer</p>
              <div className="bg-black/40 rounded-xl p-4 mb-6 border border-white/5">
                <p className="text-zinc-400 text-sm leading-relaxed">
                  "I am a Pro Full Stack Expert specializing in creating robust, scalable web solutions. With deep expertise in modern frameworks and AI integration, I transform complex requirements into seamless, high-performance digital experiences."
                </p>
              </div>
              <div className="flex gap-4">
                <a href="#" className="p-3 bg-zinc-800/50 rounded-full text-zinc-400 hover:bg-black hover:text-white border border-white/5 transition-all hover:scale-110"><Github className="w-5 h-5" /></a>
                <a href="#" className="p-3 bg-zinc-800/50 rounded-full text-zinc-400 hover:bg-[#0077b5] hover:text-white border border-white/5 transition-all hover:scale-110"><Linkedin className="w-5 h-5" /></a>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}