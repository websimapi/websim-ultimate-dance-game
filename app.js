const { useState, useEffect, useRef, useSyncExternalStore } = React;

// Initialize WebsimSocket
const room = new WebsimSocket();

// Pose detection utilities
class PoseDetector {
    constructor() {
        this.pose = null;
        this.faceMesh = null;
        this.hands = null;
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;

        // Initialize MediaPipe Pose
        this.pose = new Pose({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404/${file}`;
            }
        });

        this.pose.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            smoothSegmentation: false,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        // Initialize MediaPipe Hands
        this.hands = new Hands({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675466862/${file}`;
            }
        });

        this.hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        // Initialize MediaPipe FaceMesh
        this.faceMesh = new FaceMesh({
            locateFile: (file) => {
                return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1675466862/${file}`;
            }
        });

        this.faceMesh.setOptions({
            maxNumFaces: 1,
            refineLandmarks: true,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        this.isInitialized = true;
    }

    async detectPose(imageElement) {
        if (!this.isInitialized) await this.initialize();

        return new Promise((resolve) => {
            const results = {
                pose: null,
                hands: null,
                face: null
            };

            let completedCount = 0;
            const checkComplete = () => {
                completedCount++;
                if (completedCount === 3) {
                    resolve(results);
                }
            };

            this.pose.onResults((poseResults) => {
                results.pose = poseResults;
                checkComplete();
            });

            this.hands.onResults((handResults) => {
                results.hands = handResults;
                checkComplete();
            });

            this.faceMesh.onResults((faceResults) => {
                results.face = faceResults;
                checkComplete();
            });

            this.pose.send({ image: imageElement });
            this.hands.send({ image: imageElement });
            this.faceMesh.send({ image: imageElement });
        });
    }
}

// Pose comparison utilities
class PoseComparer {
    static calculateSimilarity(pose1, pose2) {
        if (!pose1 || !pose2) return 0;
        
        const landmarks1 = pose1.pose?.poseLandmarks || [];
        const landmarks2 = pose2.pose?.poseLandmarks || [];
        
        if (landmarks1.length === 0 || landmarks2.length === 0) return 0;

        let totalDistance = 0;
        let validPoints = 0;

        for (let i = 0; i < Math.min(landmarks1.length, landmarks2.length); i++) {
            const p1 = landmarks1[i];
            const p2 = landmarks2[i];
            
            if (p1.visibility > 0.5 && p2.visibility > 0.5) {
                const distance = Math.sqrt(
                    Math.pow(p1.x - p2.x, 2) + 
                    Math.pow(p1.y - p2.y, 2) + 
                    Math.pow(p1.z - p2.z, 2)
                );
                totalDistance += distance;
                validPoints++;
            }
        }

        if (validPoints === 0) return 0;
        
        const averageDistance = totalDistance / validPoints;
        const similarity = Math.max(0, 1 - averageDistance * 2);
        
        return similarity * 100;
    }

    static normalizeForHeight(pose, referenceHeight = 1.0) {
        if (!pose || !pose.pose?.poseLandmarks) return pose;

        const landmarks = pose.pose.poseLandmarks;
        const nose = landmarks[0];
        const leftAnkle = landmarks[27];
        const rightAnkle = landmarks[28];

        if (!nose || !leftAnkle || !rightAnkle) return pose;

        const avgAnkle = {
            y: (leftAnkle.y + rightAnkle.y) / 2
        };

        const currentHeight = Math.abs(nose.y - avgAnkle.y);
        const scale = referenceHeight / currentHeight;

        const normalizedPose = JSON.parse(JSON.stringify(pose));
        normalizedPose.pose.poseLandmarks = landmarks.map(landmark => ({
            ...landmark,
            x: landmark.x * scale,
            y: landmark.y * scale,
            z: landmark.z * scale
        }));

        return normalizedPose;
    }
}

// Main App Component
function App() {
    const [gameState, setGameState] = useState('idle'); // idle, recording, playing
    const [currentScore, setCurrentScore] = useState(0);
    const [selectedDance, setSelectedDance] = useState(null);
    const [musicFile, setMusicFile] = useState(null);
    const [isRecording, setIsRecording] = useState(false);
    const [error, setError] = useState(null);
    const [poseData, setPoseData] = useState([]);
    const [currentPoseIndex, setCurrentPoseIndex] = useState(0);
    
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const audioRef = useRef(null);
    const poseDetector = useRef(new PoseDetector());
    const recordingData = useRef([]);
    const animationFrame = useRef(null);
    const startTime = useRef(null);

    // Get dance recordings from database
    const danceRecordings = useSyncExternalStore(
        room.collection('dance_recording').subscribe,
        room.collection('dance_recording').getList
    );

    useEffect(() => {
        initializeCamera();
        return () => {
            if (animationFrame.current) {
                cancelAnimationFrame(animationFrame.current);
            }
        };
    }, []);

    const initializeCamera = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480 },
                audio: false
            });
            
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play();
            }
            
            startPoseDetection();
        } catch (err) {
            setError('Could not access camera. Please allow camera permissions.');
        }
    };

    const startPoseDetection = () => {
        const detectPoses = async () => {
            if (!videoRef.current || !canvasRef.current) return;

            try {
                const results = await poseDetector.current.detectPose(videoRef.current);
                
                if (isRecording) {
                    const timestamp = Date.now() - startTime.current;
                    recordingData.current.push({
                        timestamp,
                        poses: results
                    });
                }

                if (gameState === 'playing' && selectedDance) {
                    const currentTime = Date.now() - startTime.current;
                    const targetPose = findPoseAtTime(selectedDance.poseData, currentTime);
                    
                    if (targetPose && results.pose) {
                        const similarity = PoseComparer.calculateSimilarity(results, targetPose.poses);
                        setCurrentScore(similarity);
                    }
                }

                drawPoses(results);
            } catch (err) {
                console.error('Pose detection error:', err);
            }

            animationFrame.current = requestAnimationFrame(detectPoses);
        };

        detectPoses();
    };

    const drawPoses = (results) => {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        if (results.pose?.poseLandmarks) {
            drawConnectors(ctx, results.pose.poseLandmarks, POSE_CONNECTIONS, { color: '#00FF00', lineWidth: 2 });
            drawLandmarks(ctx, results.pose.poseLandmarks, { color: '#FF0000', lineWidth: 1 });
        }

        if (results.hands?.multiHandLandmarks) {
            for (const landmarks of results.hands.multiHandLandmarks) {
                drawConnectors(ctx, landmarks, HAND_CONNECTIONS, { color: '#CC0000', lineWidth: 2 });
                drawLandmarks(ctx, landmarks, { color: '#FF0000', lineWidth: 1 });
            }
        }

        if (results.face?.multiFaceLandmarks) {
            for (const landmarks of results.face.multiFaceLandmarks) {
                drawConnectors(ctx, landmarks, FACEMESH_TESSELATION, { color: '#C0C0C070', lineWidth: 1 });
            }
        }
    };

    const startRecording = async () => {
        if (!musicFile) {
            setError('Please select a music file first');
            return;
        }

        setIsRecording(true);
        setGameState('recording');
        recordingData.current = [];
        startTime.current = Date.now();
        
        if (audioRef.current) {
            audioRef.current.currentTime = 0;
            audioRef.current.play();
        }
    };

    const stopRecording = async () => {
        setIsRecording(false);
        setGameState('idle');
        
        if (audioRef.current) {
            audioRef.current.pause();
        }

        try {
            const currentUser = await window.websim.getCurrentUser();
            const musicUrl = await websim.upload(musicFile);
            
            const recording = await room.collection('dance_recording').create({
                title: `${currentUser.username}'s Dance`,
                musicUrl: musicUrl,
                musicName: musicFile.name,
                poseData: recordingData.current,
                duration: recordingData.current.length > 0 ? recordingData.current[recordingData.current.length - 1].timestamp : 0
            });

            setError(null);
            console.log('Recording saved:', recording);
        } catch (err) {
            setError('Failed to save recording: ' + err.message);
        }
    };

    const playDance = async (dance) => {
        if (!dance || !dance.poseData) return;

        setSelectedDance(dance);
        setGameState('playing');
        setCurrentScore(0);
        startTime.current = Date.now();
        
        // Load and play the music
        if (audioRef.current) {
            audioRef.current.src = dance.musicUrl;
            audioRef.current.currentTime = 0;
            audioRef.current.play();
        }
    };

    const stopPlaying = () => {
        setGameState('idle');
        setSelectedDance(null);
        setCurrentScore(0);
        
        if (audioRef.current) {
            audioRef.current.pause();
        }
    };

    const findPoseAtTime = (poseData, currentTime) => {
        if (!poseData || poseData.length === 0) return null;
        
        for (let i = 0; i < poseData.length; i++) {
            if (poseData[i].timestamp >= currentTime) {
                return poseData[i];
            }
        }
        
        return poseData[poseData.length - 1];
    };

    const handleFileUpload = (event) => {
        const file = event.target.files[0];
        if (file) {
            setMusicFile(file);
            setError(null);
        }
    };

    const getStatusClass = () => {
        switch (gameState) {
            case 'recording': return 'status-recording';
            case 'playing': return 'status-playing';
            default: return 'status-idle';
        }
    };

    const getStatusText = () => {
        switch (gameState) {
            case 'recording': return 'Recording Dance...';
            case 'playing': return `Playing: ${selectedDance?.title || 'Unknown'}`;
            default: return 'Ready';
        }
    };

    return (
        <div className="app">
            <div className="header">
                <h1>Ultimate Dance Game</h1>
                <p>Record your dance moves and challenge others to match them!</p>
            </div>

            <div className="game-container">
                <div className="camera-section">
                    <div className="video-container">
                        <video 
                            ref={videoRef}
                            className="video-canvas"
                            autoPlay
                            muted
                            playsInline
                        />
                        <canvas 
                            ref={canvasRef}
                            className="pose-overlay"
                            width="640"
                            height="480"
                        />
                    </div>

                    <div className={`status-indicator ${getStatusClass()}`}>
                        {getStatusText()}
                    </div>

                    {error && (
                        <div className="error">
                            {error}
                        </div>
                    )}

                    <div className="controls">
                        <div className="file-input">
                            <input
                                type="file"
                                id="music-file"
                                accept="audio/*,video/*"
                                onChange={handleFileUpload}
                            />
                            <label htmlFor="music-file">
                                📁 Select Music
                            </label>
                        </div>

                        <button 
                            className="btn btn-record"
                            onClick={startRecording}
                            disabled={!musicFile || gameState !== 'idle'}
                        >
                            🎥 Record Dance
                        </button>

                        <button 
                            className="btn btn-stop"
                            onClick={gameState === 'recording' ? stopRecording : stopPlaying}
                            disabled={gameState === 'idle'}
                        >
                            ⏹️ Stop
                        </button>
                    </div>

                    {musicFile && (
                        <div className="music-player">
                            <h3>🎵 {musicFile.name}</h3>
                            <audio 
                                ref={audioRef}
                                controls
                                style={{ width: '100%' }}
                            />
                        </div>
                    )}
                </div>

                <div className="sidebar">
                    <h2>Dance Recordings</h2>
                    
                    {gameState === 'playing' && (
                        <div className="score-display">
                            <h3>Score: {Math.round(currentScore)}%</h3>
                            <div className="score-bar">
                                <div 
                                    className="score-fill"
                                    style={{ width: `${currentScore}%` }}
                                />
                            </div>
                        </div>
                    )}

                    <div className="dance-list">
                        {danceRecordings.length === 0 ? (
                            <div className="loading">
                                No dance recordings yet. Create the first one!
                            </div>
                        ) : (
                            danceRecordings.reverse().map((dance) => (
                                <div 
                                    key={dance.id}
                                    className="dance-item"
                                    onClick={() => playDance(dance)}
                                >
                                    <h3>{dance.title}</h3>
                                    <p>🎵 {dance.musicName}</p>
                                    <p>👤 {dance.username}</p>
                                    <p>⏱️ {Math.round(dance.duration / 1000)}s</p>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

// Render the app
ReactDOM.render(<App />, document.getElementById('root'));

