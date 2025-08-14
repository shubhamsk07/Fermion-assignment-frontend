import { useEffect, useRef, useState } from 'react'

import * as mediasoupClient from "mediasoup-client";
import type { Consumer, RtpCapabilities } from 'mediasoup-client/types';

function P2P() {

    const [connecting, setConnecting] = useState('');

    const [hasLocalStream, setHasLocalStream] = useState(false);
    const [hasRemoteStream, setHasRemoteStream] = useState(false);

    const localVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
    const remoteAudioRef = useRef<HTMLAudioElement | null>(null); // Add ref for remote audio
    const deviceRef = useRef<mediasoupClient.Device | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const producerTransportRef = useRef<any | null>(null);
    const consumerTransportRef = useRef<any | null>(null);

    const drawingRef = useRef<boolean>(false);

    const consumersRef = useRef<Map<string,Consumer>>(new Map());

    useEffect(() => {

        const localVideo = localVideoRef.current;
        const remoteVideo = remoteVideoRef.current;

        if (!localVideo || !remoteVideo) return;
        // Listen for video events
        const handleVideoReady = () => {
            console.log('Video event triggered');
        };

        localVideo.addEventListener('loadeddata', handleVideoReady);
        remoteVideo.addEventListener('loadeddata', handleVideoReady);
        localVideo.addEventListener('playing', handleVideoReady);
        remoteVideo.addEventListener('playing', handleVideoReady);
        localVideo.addEventListener('canplay', handleVideoReady);
        remoteVideo.addEventListener('canplay', handleVideoReady);

        return () => {

            localVideo.removeEventListener('loadeddata', handleVideoReady);
            remoteVideo.removeEventListener('loadeddata', handleVideoReady);
            localVideo.removeEventListener('playing', handleVideoReady);
            remoteVideo.removeEventListener('playing', handleVideoReady);
            localVideo.removeEventListener('canplay', handleVideoReady);
            remoteVideo.removeEventListener('canplay', handleVideoReady);
        };
    }, [hasLocalStream, hasRemoteStream]);




    useEffect(() => {
        const socket = new WebSocket('https://35.154.255.219:3002/');
        socketRef.current = socket;

        socket.onopen = () => {
            console.log('Websocket connected');
            socket.send(JSON.stringify({ type: "getRouterCapabilities" }));
        };

        socket.onmessage = async (event) => {
            const data = JSON.parse(event.data.toString());
            console.log("Received message:", data.type);

            switch (data.type) {
                case "getRouterCapabilities":
                    console.log('Router capabilities received');
                    await loadDevice({ routerRtpCapabilities: data.data });
                    socket.send(JSON.stringify({ type: "createConsumerTransport" }));
                    break;

                case 'ProducerTransportCreated':
                    console.log('Producer transport created');
                    if (data.error) {
                        console.error("Producer transport create error", data.error);
                        return;
                    }

                    // Check if this is for canvas or webcam

                    await createProducerTransport(data.data);

                    break;

                case 'ConsumerTransportCreated':
                    console.log('Creating consumer transport');
                    if (data.error) {
                        console.error("Consumer transport create error", data.error);
                        return;
                    }
                    await createConsumerTransport(data.data);
                    break;

                case 'newProducer':
                    console.log('New producer available:', data.producerId);
                    if (data.producerId && data.kind) {
                        // Add a generic consume function that handles any kind
                        consumeProducer(data.producerId, data.kind);
                    }
                    break;

                case 'consumed':
                    console.log('Consumer created, resuming...');
                    await resumeConsumer(data.data);
                    break;

                case 'consumerResumed':
                    console.log('Consumer resumed successfully');
                    break;

                case 'producerClosed':
                    console.log('Producer closed:', data.producerId);

                    // Clean up consumer
                    const consumer = consumersRef.current.get(data.producerId);
                    if (consumer) {
                        consumer.close();
                        consumersRef.current.delete(data.producerId);
                    }

                    // Reset remote video if it was the remote stream
                    if (hasRemoteStream) {
                        const remoteVideo = remoteVideoRef.current;
                        if (remoteVideo) {
                            remoteVideo.srcObject = null;
                        }
                        setHasRemoteStream(false);

                        drawingRef.current = false;
                    }
                    break;

                case 'error':
                    console.error('Server error:', data.message);
                    break;

                default:
                    console.log('Unknown message type:', data.type);
            }
        };
        const consumeProducer = async (producerId: string, kind: 'audio' | 'video') => {
            if (!deviceRef.current || !socketRef.current) return;
            console.log(`Requesting to consume ${kind} producer: ${producerId}`);
            socketRef.current.send(
                JSON.stringify({
                    type: "consume",
                    producerId,
                    rtpCapabilities: deviceRef.current.rtpCapabilities,
                })
            );
        };

        // Transport creation functions
        const createProducerTransport = async (transportData: any) => {
            const device = deviceRef.current;
            if (!device) return console.error("Device not loaded yet");

            console.log("Creating webcam producer transport");
            const transport = device.createSendTransport(transportData);
            producerTransportRef.current = transport;

            transport.on('connect', async ({ dtlsParameters }, callback) => {
                console.log("Connecting webcam producer transport");
                socket.send(JSON.stringify({
                    type: 'connectProducerTransport',
                    dtlsParameters
                }));

                const handler = (event: MessageEvent) => {
                    const resp = JSON.parse(event.data);
                    if (resp.type === 'producerConnected') {
                        socket.removeEventListener('message', handler);
                        callback();
                    }
                };
                socket.addEventListener('message', handler);
            });

            transport.on('produce', async ({ kind, rtpParameters }, callback) => {
                console.log(`Producing ${kind} media`);
                socket.send(JSON.stringify({
                    type: 'produce',
                    transportId: transport.id,
                    kind,
                    rtpParameters
                }));

                const handler = (event: MessageEvent) => {
                    const resp = JSON.parse(event.data);
                    if (resp.type === 'published') {
                        socket.removeEventListener('message', handler);
                        callback(resp.data.id);
                    }
                };
                socket.addEventListener('message', handler);
            });

            transport.on('connectionstatechange', async (state) => {
                console.log('Webcam producer transport state:', state);
                setConnecting(`Webcam: ${state}`);
            });

            try {
                console.log('Getting user media...');
                const stream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 }
                    },
                    audio: true // Request audio track too
                });

                const localVideo = localVideoRef.current;
                if (localVideo) {
                    localVideo.srcObject = stream;
                    await localVideo.play();
                    setHasLocalStream(true);
                    console.log('Local video started');
                }

                // Produce video track
                const videoTrack = stream.getVideoTracks()[0];
                if (videoTrack) {
                    console.log('Starting to produce webcam video track...');
                    const videoProducer = await transport.produce({ track: videoTrack });
                    console.log('Webcam video producer created:', videoProducer.id);
                }

                // Produce audio track on the same transport
                const audioTrack = stream.getAudioTracks()[0];
                if (audioTrack) {
                    console.log('Starting to produce microphone audio track...');
                    const audioProducer = await transport.produce({ track: audioTrack });
                    console.log('Microphone audio producer created:', audioProducer.id);
                }

            } catch (error) {
                console.error('Error getting user media or producing:', error);
                alert('Error accessing webcam/microphone: ' + error);
            }
        };


        const createConsumerTransport = async (transportData: any) => {
            const device = deviceRef.current;
            if (!device) return console.error("Device not loaded yet");

            console.log("Creating consumer transport");
            const consumerTransport = device.createRecvTransport(transportData);
            consumerTransportRef.current = consumerTransport;

            consumerTransport.on('connect', async ({ dtlsParameters }, callback) => {
                console.log("Connecting consumer transport");
                socket.send(JSON.stringify({
                    type: 'connectConsumerTransport',
                    dtlsParameters
                }));

                const handler = (event: MessageEvent) => {
                    const resp = JSON.parse(event.data);
                    if (resp.type === 'consumerConnected') {
                        socket.removeEventListener('message', handler);
                        callback();
                    }
                };
                socket.addEventListener('message', handler);
            });
        };



      const resumeConsumer = async (consumerData: any) => {
    const consumerTransport = consumerTransportRef.current;
    if (!consumerTransport || !socket) {
        console.error("Consumer transport or socket not ready");
        return;
    }

    try {
        console.log('Creating consumer with data:', consumerData);
        const consumer = await consumerTransport.consume({
            id: consumerData.id,
            producerId: consumerData.producerId,
            kind: consumerData.kind,
            rtpParameters: consumerData.rtpParameters
        });

        // Store consumer reference
        consumersRef.current.set(consumerData.producerId, consumer);

        console.log('Consumer created, resuming...');
        socket.send(JSON.stringify({
            type: 'resumeConsumer',
            consumerId: consumer.id
        }));

        const stream = new MediaStream([consumer.track]);

        if (consumerData.kind === 'video') {
            const remoteVideo = remoteVideoRef.current;
            if (remoteVideo) {
                // Check if video element already has a stream (audio might be there)
                if (remoteVideo.srcObject) {
                    const existingStream = remoteVideo.srcObject as MediaStream;
                    existingStream.addTrack(consumer.track);
                } else {
                    remoteVideo.srcObject = stream;
                }

                remoteVideo.muted = false; // ⭐ CHANGED: Don't mute remote video!
                await remoteVideo.play();
                setHasRemoteStream(true);
                console.log('Remote video playing (with audio enabled)');
            }
        } else if (consumerData.kind === 'audio') {
            const remoteVideo = remoteVideoRef.current;
            if (remoteVideo) {
                // Add audio track to the video element
                if (remoteVideo.srcObject) {
                    const existingStream = remoteVideo.srcObject as MediaStream;
                    existingStream.addTrack(consumer.track);
                } else {
                    remoteVideo.srcObject = stream;
                }

                remoteVideo.muted = false; // ⭐ CRITICAL: Unmute for audio
                console.log('Added audio track to remote video element');

                // Ensure it's playing
                try {
                    await remoteVideo.play();
                } catch (playError) {
                    console.warn('Need user interaction for audio:', playError);
                }
            }
        }
    } catch (error) {
        console.error('Error creating consumer:', error);
    }
};


        const loadDevice = async ({ routerRtpCapabilities }: { routerRtpCapabilities: RtpCapabilities }) => {
            try {
                const device = new mediasoupClient.Device();
                await device.load({ routerRtpCapabilities });
                deviceRef.current = device;
                console.log("Device loaded successfully");
            } catch (error: any) {
                if (error.name === 'UnsupportedError') {
                    console.log('Browser not supported');
                }
                console.error('Error loading device:', error);
            }
        };

        // Handle canvas transport creation response

        socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

        socket.onclose = () => {
            console.log('WebSocket connection closed');
            setHasLocalStream(false);
            setHasRemoteStream(false);
        };

        return () => {
            // Cleanup


            consumersRef.current.forEach(consumer => consumer.close());
            consumersRef.current.clear();
            socket.close();
        };
    }, []);

    const publish = () => {
        const device = deviceRef.current;
        const socket = socketRef.current;

        if (!socket || !device) {
            console.warn("Socket or device not ready");
            return;
        }
        if (hasLocalStream) {
            alert('Webcam is already streaming');
            return;
        }

        console.log('Starting webcam stream');
        socket.send(JSON.stringify({
            type: "createProducerTransport",
            forceTcp: false,
            rtpCapabilities: device.rtpCapabilities
        }));
    };

    return (
        <div className="p-4">
            <div className='flex gap-4 mb-4'>
                <div className="flex flex-col items-center">
                </div>
                <div className="flex flex-col items-center">
                    <video ref={localVideoRef} autoPlay muted className='w-80 h-60 border-2 border-blue-400 bg-black' />
                    <span className="text-sm mt-1">Local Video</span>
                </div>
                <div className="flex flex-col items-center">
                    <video ref={remoteVideoRef} autoPlay muted className='w-80 h-60 border-2 border-red-400 bg-black' />
                    <audio ref={remoteAudioRef} autoPlay />
                    <span className="text-sm mt-1">Remote Video</span>
                </div>
            </div>

            <div className="flex gap-2 mb-4">
                <button
                    onClick={publish}
                    disabled={hasLocalStream}
                    className={`px-4 py-2 rounded text-white ${hasLocalStream
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-blue-500 hover:bg-blue-600'
                        }`}
                >
                    {hasLocalStream ? 'Webcam Active' : 'Start Webcam'}
                </button>

            </div>

            <div className="text-sm space-y-1">
                <div>Connection Status: {connecting}</div>
                <div>Local Stream: {hasLocalStream ? '✅' : '❌'}</div>
                <div>Remote Stream: {hasRemoteStream ? '✅' : '❌'}</div>

            </div>
        </div>
    );
}

export default P2P;
