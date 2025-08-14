import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, StopCircle, Play, Wifi, WifiOff, AlertCircle, RefreshCw } from 'lucide-react';
import * as mediasoupClient from 'mediasoup-client';

const WebcamStreamer = () => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState('');
  const [clientId, setClientId] = useState('');
  const [streamStatus, setStreamStatus] = useState('disconnected');

  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const deviceRef = useRef(null);
  const transportRef = useRef(null);
  const streamRef = useRef(null);
  const producersRef = useRef(new Map());
  const pendingRequests = useRef(new Map());
  const reconnectTimeoutRef = useRef(null);

  // Generate unique request ID
  const generateRequestId = () => Math.random().toString(36).substr(2, 9);

  // WebSocket message handler
  const handleWebSocketMessage = useCallback((event) => {
    try {
      const message = JSON.parse(event.data);
      const { type, data, id } = message;

      // Handle request-response pattern
      if (id && pendingRequests.current.has(id)) {
        const { resolve, reject } = pendingRequests.current.get(id);
        pendingRequests.current.delete(id);

        if (type === 'error') {
          reject(new Error(data.error));
        } else {
          resolve(data);
        }
        return;
      }

      // Handle broadcast messages
      switch (type) {
        case 'connected':
          setClientId(data.clientId);
          setIsConnected(true);
          setStreamStatus('connected');
          console.log('Connected to server with ID:', data.clientId);
          break;

        case 'pong':
          // Handle ping response
          break;

        default:
          console.log('Received message:', type, data);
      }
    } catch (error) {
      console.error('Error parsing WebSocket message:', error);
    }
  }, []);

  // Send message with promise-based response
  const sendMessage = (type, data = {}) => {
    return new Promise((resolve, reject) => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const id = generateRequestId();
      pendingRequests.current.set(id, { resolve, reject });

      wsRef.current.send(JSON.stringify({ type, data, id }));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingRequests.current.has(id)) {
          pendingRequests.current.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  };

  // Connect to WebSocket
  const connectWebSocket = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    try {
      wsRef.current = new WebSocket('ws://localhost:3001');

      wsRef.current.onopen = () => {
        console.log('WebSocket connected');
        setError('');
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      wsRef.current.onmessage = handleWebSocketMessage;

      wsRef.current.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason);
        setIsConnected(false);
        setStreamStatus('disconnected');

        // Attempt to reconnect after 3 seconds
        if (!reconnectTimeoutRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            console.log('Attempting to reconnect...');
            connectWebSocket();
          }, 3000);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
        setError('WebSocket connection failed');
        setIsConnected(false);
        setStreamStatus('error');
      };
    } catch (error) {
      console.error('Error creating WebSocket:', error);
      setError('Failed to create WebSocket connection');
    }
  }, [handleWebSocketMessage]);

  // Initialize MediaSoup device
  const initializeDevice = async () => {
    try {
      deviceRef.current = new mediasoupClient.Device();

      // Get RTP capabilities from server
      const rtpCapabilities = await sendMessage('getRtpCapabilities');
      await deviceRef.current.load({ routerRtpCapabilities: rtpCapabilities });

      console.log('MediaSoup device initialized');
    } catch (err) {
      console.error('Error initializing device:', err);
      throw new Error('Failed to initialize media device: ' + err.message);
    }
  };

  // Create WebRTC transport
  const createTransport = async () => {
    try {
      const transportInfo = await sendMessage('createWebRtcTransport');

      transportRef.current = deviceRef.current.createSendTransport(transportInfo);

      transportRef.current.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          await sendMessage('connectTransport', { dtlsParameters });
          callback();
        } catch (err) {
          errback(err);
        }
      });

      transportRef.current.on('produce', async (parameters, callback, errback) => {
        try {
          const result = await sendMessage('produce', {
            kind: parameters.kind,
            rtpParameters: parameters.rtpParameters,
          });
          callback({ id: result.id });
        } catch (err) {
          errback(err);
        }
      });

      transportRef.current.on('connectionstatechange', (state) => {
        console.log('Transport connection state:', state);
        if (state === 'connected') {
          setStreamStatus('streaming');
        } else if (state === 'failed' || state === 'disconnected') {
          setStreamStatus('error');
        }
      });

      console.log('WebRTC transport created');
    } catch (err) {
      console.error('Error creating transport:', err);
      throw new Error('Failed to create transport: ' + err.message);
    }
  };

  // Start streaming
  const startStreaming = async () => {
    try {
      setError('');
      setStreamStatus('initializing');

      // Get user media
      const constraints = {
        video: {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 },
          facingMode: 'user'
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 48000
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }

      // Initialize MediaSoup device if not already done
      if (!deviceRef.current) {
        await initializeDevice();
      }

      // Create transport if not already done
      if (!transportRef.current) {
        await createTransport();
      }

      // Produce video and audio
      const videoTrack = stream.getVideoTracks()[0];
      const audioTrack = stream.getAudioTracks()[0];

      if (videoTrack) {
        const videoProducer = await transportRef.current.produce({
          track: videoTrack,
          encodings: [
            { maxBitrate: 1000000, maxFramerate: 30 }
          ],
          codecOptions: {
            videoGoogleStartBitrate: 1000
          }
        });
        producersRef.current.set('video', videoProducer);
        console.log('Video producer created:', videoProducer.id);
      }

      if (audioTrack) {
        const audioProducer = await transportRef.current.produce({
          track: audioTrack,
        });
        producersRef.current.set('audio', audioProducer);
        console.log('Audio producer created:', audioProducer.id);
      }

      setIsStreaming(true);
      setStreamStatus('streaming');
      console.log('Streaming started successfully');
    } catch (err) {
      console.error('Error starting stream:', err);
      setError('Failed to start streaming: ' + err.message);
      setStreamStatus('error');
      stopStreaming();
    }
  };

  // Stop streaming
  const stopStreaming = () => {
    try {
      // Stop all tracks
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => {
          track.stop();
        });
        streamRef.current = null;
      }

      // Clear video element
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }

      // Close producers
      producersRef.current.forEach(producer => {
        producer.close();
      });
      producersRef.current.clear();

      // Close transport
      if (transportRef.current) {
        transportRef.current.close();
        transportRef.current = null;
      }

      // Reset device
      deviceRef.current = null;

      setIsStreaming(false);
      setStreamStatus(isConnected ? 'connected' : 'disconnected');
      console.log('Streaming stopped');
    } catch (error) {
      console.error('Error stopping stream:', error);
    }
  };

  // Open watch page
  const openWatchPage = () => {
    window.open('http://localhost:3001/watch', '_blank');
  };

  // Manual reconnect
  const manualReconnect = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    setTimeout(() => {
      connectWebSocket();
    }, 500);
  };

  // Ping server periodically
  useEffect(() => {
    const pingInterval = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        sendMessage('ping').catch(console.error);
      }
    }, 30000);

    return () => clearInterval(pingInterval);
  }, []);

  // Initialize WebSocket connection
  useEffect(() => {
    connectWebSocket();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      stopStreaming();
    };
  }, [connectWebSocket]);

  // Get status color and text
  const getStatusColor = () => {
    switch (streamStatus) {
      case 'streaming': return 'text-green-400';
      case 'connected': return 'text-blue-400';
      case 'initializing': return 'text-yellow-400';
      case 'error': return 'text-red-400';
      default: return 'text-gray-400';
    }
  };

  const getStatusText = () => {
    switch (streamStatus) {
      case 'streaming': return 'Live Streaming';
      case 'connected': return 'Connected';
      case 'initializing': return 'Initializing...';
      case 'error': return 'Error';
      default: return 'Disconnected';
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold mb-4 flex items-center justify-center gap-3">
            <Camera className="w-10 h-10 text-blue-400" />
            WebRTC Live Streamer
          </h1>
          <div className="flex items-center justify-center gap-4 mb-4">
            <div className="flex items-center gap-2">
              {isConnected ? (
                <Wifi className="w-5 h-5 text-green-400" />
              ) : (
                <WifiOff className="w-5 h-5 text-red-400" />
              )}
              <span className={getStatusColor()}>
                {getStatusText()}
              </span>
            </div>
            {clientId && (
              <div className="text-sm text-gray-400 bg-gray-800 px-3 py-1 rounded-full">
                ID: {clientId.slice(0, 8)}
              </div>
            )}
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-500 bg-opacity-20 border border-red-500 text-red-200 p-4 rounded-lg mb-6 flex items-center gap-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Main Content */}
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Video Preview - Takes up 2 columns */}
          <div className="lg:col-span-2 bg-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold">Camera Preview</h3>
              {streamStatus === 'streaming' && (
                <div className="bg-red-600 text-white px-3 py-1 rounded-full text-sm font-medium flex items-center gap-2">
                  <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
                  LIVE
                </div>
              )}
            </div>
            <div className="relative bg-black rounded-lg overflow-hidden aspect-video">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover"
              />
              {!isStreaming && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="text-center">
                    <Camera className="w-16 h-16 text-gray-600 mx-auto mb-4" />
                    <p className="text-gray-400">Camera preview will appear here</p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Controls Panel */}
          <div className="bg-gray-800 rounded-xl p-6">
            <h3 className="text-xl font-semibold mb-4">Stream Controls</h3>

            <div className="space-y-4">
              {/* Main Control Button */}
              <div className="flex gap-2">
                {!isStreaming ? (
                  <button
                    onClick={startStreaming}
                    disabled={!isConnected || streamStatus === 'initializing'}
                    className="flex-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white px-4 py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                  >
                    <Play className="w-5 h-5" />
                    {streamStatus === 'initializing' ? 'Starting...' : 'Start Stream'}
                  </button>
                ) : (
                  <button
                    onClick={stopStreaming}
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white px-4 py-3 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                  >
                    <StopCircle className="w-5 h-5" />
                    Stop Stream
                  </button>
                )}
              </div>

              {/* Secondary Actions */}
              <div className="grid grid-cols-1 gap-2">
                <button
                  onClick={openWatchPage}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-medium transition-colors"
                >
                  📺 Open Watch Page
                </button>

                <button
                  onClick={manualReconnect}
                  disabled={isConnected}
                  className="w-full bg-gray-600 hover:bg-gray-700 disabled:bg-gray-500 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg font-medium flex items-center justify-center gap-2 transition-colors"
                >
                  <RefreshCw className="w-4 h-4" />
                  {isConnected ? 'Connected' : 'Reconnect'}
                </button>
              </div>

              {/* Stream Information */}
              <div className="bg-gray-700 rounded-lg p-4">
                <h4 className="font-medium mb-3">Stream Information</h4>
                <div className="text-sm text-gray-300 space-y-2">
                  <div className="flex justify-between">
                    <span>Status:</span>
                    <span className={getStatusColor()}>{getStatusText()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Connection:</span>
                    <span className={isConnected ? 'text-green-400' : 'text-red-400'}>
                      {isConnected ? 'Connected' : 'Disconnected'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Producers:</span>
                    <span className="text-blue-400">{producersRef.current.size}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Client ID:</span>
                    <span className="text-gray-400 font-mono">
                      {clientId ? clientId.slice(0, 8) + '...' : 'N/A'}
                    </span>
                  </div>
                </div>
              </div>

              {/* URLs */}
              <div className="bg-gray-700 rounded-lg p-4">
                <h4 className="font-medium mb-3">Stream URLs</h4>
                <div className="text-xs text-gray-300 space-y-1 break-all">
                  <div>
                    <span className="text-blue-400">Watch:</span><br />
                    http://localhost:3001/watch
                  </div>
                  <div>
                    <span className="text-blue-400">HLS:</span><br />
                    http://localhost:3001/public/stream.m3u8
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Status Dashboard */}
        <div className="mt-8 bg-gray-800 rounded-xl p-6">
          <h3 className="text-xl font-semibold mb-4">Connection Status</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
            <div className="bg-gray-700 rounded-lg p-3">
              <div className="text-lg font-bold">WebSocket</div>
              <div className={`text-sm ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
                {isConnected ? 'Connected' : 'Disconnected'}
              </div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3">
              <div className="text-lg font-bold">Device</div>
              <div className={`text-sm ${deviceRef.current ? 'text-green-400' : 'text-gray-400'}`}>
                {deviceRef.current ? 'Ready' : 'Not Ready'}
              </div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3">
              <div className="text-lg font-bold">Transport</div>
              <div className={`text-sm ${transportRef.current ? 'text-green-400' : 'text-gray-400'}`}>
                {transportRef.current ? 'Created' : 'Not Created'}
              </div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3">
              <div className="text-lg font-bold">Producers</div>
              <div className={`text-sm ${producersRef.current.size > 0 ? 'text-green-400' : 'text-gray-400'}`}>
                {producersRef.current.size} Active
              </div>
            </div>
            <div className="bg-gray-700 rounded-lg p-3">
              <div className="text-lg font-bold">Stream</div>
              <div className={`text-sm ${isStreaming ? 'text-green-400' : 'text-red-400'}`}>
                {isStreaming ? 'Live' : 'Offline'}
              </div>
            </div>
          </div>
        </div>

        {/* Setup Instructions */}
        <div className="mt-8 bg-gray-800 rounded-xl p-6">
          <h3 className="text-xl font-semibold mb-4">Setup Instructions</h3>
          <div className="text-sm text-gray-300 space-y-2">
            <p>1. ✅ Make sure your backend server is running on port 3001</p>
            <p>2. ✅ Install required dependencies: mediasoup, ws, ffmpeg</p>
            <p>3. ✅ Ensure FFmpeg is installed on your system</p>
            <p>4. 🎯 Click "Start Stream" to begin broadcasting</p>
            <p>5. 👀 Use "Open Watch Page" to view the stream via HLS</p>
            <p>6. 📡 Stream will be available at /public/stream.m3u8</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WebcamStreamer;