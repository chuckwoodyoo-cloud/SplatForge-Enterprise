import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Color, path, Vec3 } from 'playcanvas';

import { ElementType } from './element';
import { Events } from './events';
import { PngCompressor } from './png-compressor';
import { Scene } from './scene';
import { Splat } from './splat';
import { localize } from './ui/localization';

const nullClr = new Color(0, 0, 0, 0);

// Lookup maps for video output format and codec configuration
const FORMAT_CONFIG: Record<string, { create: (streaming: boolean) => Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat; extension: string }> = {
    mp4: { create: streaming => new Mp4OutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mp4' },
    webm: { create: () => new WebMOutputFormat(), extension: 'webm' },
    mov: { create: streaming => new MovOutputFormat({ fastStart: streaming ? false : 'in-memory' }), extension: 'mov' },
    mkv: { create: () => new MkvOutputFormat(), extension: 'mkv' }
};

const CODEC_CONFIG: Record<string, { type: 'avc' | 'hevc' | 'vp9' | 'av1'; codec: (height: number) => string }> = {
    h264: { type: 'avc', codec: h => (h < 1080 ? 'avc1.420028' : 'avc1.640033') }, // H.264 Constrained Baseline/High profile
    h265: { type: 'hevc', codec: () => 'hev1.1.6.L120.B0' },                       // H.265 Main profile, Level 4.0
    vp9: { type: 'vp9', codec: () => 'vp09.00.10.08' },                            // VP9 Profile 0, Level 1.0
    av1: { type: 'av1', codec: () => 'av01.0.05M.08' }                             // AV1 Main Profile, Level 3.1
};

type ImageSettings = {
    width: number;
    height: number;
    transparentBg: boolean;
    showDebug: boolean;
};

type VideoSettings = {
    startFrame: number;
    endFrame: number;
    frameRate: number;
    width: number;
    height: number;
    bitrate: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'mp4' | 'webm' | 'mov' | 'mkv';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
};

type RecordingFormat = {
    format: 'mp4' | 'webm';
    codec: 'h264' | 'vp9';
    codecType: 'avc' | 'vp9';
    codecString: string;
    extension: string;
};

const removeExtension = (filename: string) => {
    return filename.substring(0, filename.length - path.getExtension(filename).length);
};

const downloadFile = (arrayBuffer: ArrayBuffer, filename: string) => {
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const url = window.URL.createObjectURL(blob);
    const el = document.createElement('a');
    el.download = filename;
    el.href = url;
    el.click();
    window.URL.revokeObjectURL(url);
};

const registerRenderEvents = (scene: Scene, events: Events) => {
    let compressor: PngCompressor;
    let recording = false;
    let recordingStopping = false;
    let recordingEncoder: VideoEncoder | null = null;
    let recordingOutput: Output | null = null;
    let recordingTarget: BufferTarget | null = null;
    let recordingVideoSource: EncodedVideoPacketSource | null = null;
    let recordingCanvas: HTMLCanvasElement | null = null;
    let recordingContext: CanvasRenderingContext2D | null = null;
    let recordingStartTime = 0;
    let recordingFrameIndex = 0;
    let recordingFrameRequest = -1;
    let recordingTimer = -1;
    let recordingStartTimer = -1;
    let recordingUpdateHandler: { off: () => void } | null = null;
    let recordingFormat: RecordingFormat | null = null;
    let recordingEncoderError: Error | null = null;
    let recordingBitrate = 0;
    let recordingUiStopped = false;
    const recordingPacketWrites = new Set<Promise<void>>();
    const recordingFrameRate = 30;
    const recordingMinBitrate = 20_000_000;
    const recordingMaxBitrate = 80_000_000;
    const recordingFinalizeTimeout = 8000;

    const getRecordingSize = () => {
        return {
            width: Math.max(2, Math.floor(scene.canvas.width / 2) * 2),
            height: Math.max(2, Math.floor(scene.canvas.height / 2) * 2)
        };
    };

    const getRecordingBitrate = (width: number, height: number) => {
        return Math.min(recordingMaxBitrate, Math.max(recordingMinBitrate, Math.floor(width * height * recordingFrameRate * 0.18)));
    };

    const getRecordingFormat = async (width: number, height: number, bitrate = getRecordingBitrate(width, height)): Promise<RecordingFormat | null> => {
        if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
            return null;
        }

        const options: RecordingFormat[] = [
            { format: 'mp4', codec: 'h264', codecType: 'avc', codecString: CODEC_CONFIG.h264.codec(height), extension: 'mp4' },
            { format: 'webm', codec: 'vp9', codecType: 'vp9', codecString: CODEC_CONFIG.vp9.codec(height), extension: 'webm' }
        ];

        for (const option of options) {
            const support = await VideoEncoder.isConfigSupported({
                codec: option.codecString,
                width,
                height,
                bitrate
            });

            if (support.supported) {
                return option;
            }
        }

        return null;
    };

    const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
        let timeoutId = -1;
        try {
            return await Promise.race([
                promise,
                new Promise<T>((_, reject) => {
                    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
                })
            ]);
        } finally {
            if (timeoutId !== -1) {
                window.clearTimeout(timeoutId);
            }
        }
    };

    const getSceneFilename = (extension: string) => {
        const docName = events.invoke('doc.name');
        const currentSplats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
        return `${removeExtension(docName ?? currentSplats[0]?.name ?? 'splatforge')}-recording.${extension}`;
    };

    const updateRecordingTime = () => {
        const seconds = Math.floor((performance.now() - recordingStartTime) / 1000);
        events.fire('record.video.tick', seconds);
    };

    const stopCameraInteraction = () => {
        scene.camera.controller?.resetInput?.();
        scene.camera.stopMotion();
    };

    const clearRecordingFrameRequest = () => {
        if (recordingFrameRequest !== -1) {
            window.cancelAnimationFrame(recordingFrameRequest);
            recordingFrameRequest = -1;
        }
    };

    const stopRecordingUpdate = () => {
        if (recordingTimer !== -1) {
            window.clearInterval(recordingTimer);
            recordingTimer = -1;
        }

        if (recordingStartTimer !== -1) {
            window.clearTimeout(recordingStartTimer);
            recordingStartTimer = -1;
        }

        if (recordingUpdateHandler) {
            recordingUpdateHandler.off();
            recordingUpdateHandler = null;
        }

        clearRecordingFrameRequest();
    };

    const stopRecordingUi = () => {
        if (!recordingUiStopped) {
            recordingUiStopped = true;
            events.fire('record.video.stopped');
        }
    };

    const trackRecordingPacketWrite = (promise: Promise<void>) => {
        const tracked = promise.catch((error) => {
            recordingEncoderError = error as Error;
        }).finally(() => {
            recordingPacketWrites.delete(tracked);
        });
        recordingPacketWrites.add(tracked);
    };

    const startRecordingUpdate = () => {
        if (recordingTimer !== -1) {
            return;
        }

        if (recordingStartTimer !== -1) {
            window.clearTimeout(recordingStartTimer);
            recordingStartTimer = -1;
        }

        recordingStartTime = performance.now();
        recordingTimer = window.setInterval(updateRecordingTime, 250);
        recordingUpdateHandler = events.on('update', () => {
            scene.forceRender = true;
        });

        scene.forceRender = true;
        recordingUiStopped = false;
        events.fire('record.video.started');
        updateRecordingTime();
    };

    const resetRecordingState = () => {
        if (recordingEncoder && recordingEncoder.state !== 'closed') {
            recordingEncoder.close();
        }

        recording = false;
        recordingStopping = false;
        recordingEncoder = null;
        recordingOutput = null;
        recordingTarget = null;
        recordingVideoSource = null;
        recordingCanvas = null;
        recordingContext = null;
        recordingFormat = null;
        recordingFrameIndex = 0;
        recordingEncoderError = null;
        recordingBitrate = 0;
        recordingUiStopped = false;
        recordingPacketWrites.clear();
        stopRecordingUpdate();
        scene.forceRender = true;
    };

    const captureRecordingFrame = () => {
        recordingFrameRequest = window.requestAnimationFrame(captureRecordingFrame);

        if (!recording || recordingStopping || !recordingEncoder || !recordingContext || !recordingCanvas) {
            return;
        }

        const elapsed = performance.now() - recordingStartTime;
        const expectedFrame = Math.floor(elapsed * recordingFrameRate / 1000);
        if (expectedFrame <= recordingFrameIndex || recordingEncoder.encodeQueueSize > 5) {
            return;
        }

        if (recordingEncoderError) {
            events.invoke('record.video.stop');
            events.invoke('showPopup', {
                type: 'error',
                header: localize('panel.render.failed'),
                message: `'${recordingEncoderError.message ?? recordingEncoderError}'`
            });
            return;
        }

        recordingContext.drawImage(scene.canvas, 0, 0, recordingCanvas.width, recordingCanvas.height);

        const videoFrame = new VideoFrame(recordingCanvas, {
            timestamp: Math.floor(1e6 * recordingFrameIndex / recordingFrameRate),
            duration: Math.floor(1e6 / recordingFrameRate)
        });

        recordingEncoder.encode(videoFrame, { keyFrame: recordingFrameIndex === 0 });
        videoFrame.close();
        recordingFrameIndex = expectedFrame;
    };

    // wait for postrender to fire
    const postRender = () => {
        return new Promise<boolean>((resolve, reject) => {
            const handle = scene.events.on('postrender', () => {
                handle.off();
                try {
                    resolve(true);
                } catch (error) {
                    reject(error);
                }
            });
        });
    };

    events.function('record.video.supported', async () => {
        const { width, height } = getRecordingSize();
        return !!await getRecordingFormat(width, height);
    });

    events.function('record.video.active', () => {
        return recording || recordingStopping;
    });

    events.function('record.video.start', async () => {
        if (recording || recordingStopping) {
            return true;
        }

        if (events.invoke('scene.empty')) {
            await events.invoke('showPopup', {
                type: 'info',
                header: localize('popup.error'),
                message: localize('popup.record-video.empty-scene')
            });
            return false;
        }

        if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('popup.error'),
                message: localize('popup.record-video.unsupported')
            });
            return false;
        }

        const { width, height } = getRecordingSize();
        recordingBitrate = getRecordingBitrate(width, height);
        recordingFormat = await getRecordingFormat(width, height, recordingBitrate);
        if (!recordingFormat) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('popup.error'),
                message: localize('popup.record-video.unsupported')
            });
            return false;
        }

        try {
            recordingTarget = new BufferTarget();
            recordingOutput = new Output({
                format: FORMAT_CONFIG[recordingFormat.format].create(false),
                target: recordingTarget
            });
            recordingVideoSource = new EncodedVideoPacketSource(recordingFormat.codecType);
            recordingOutput.addVideoTrack(recordingVideoSource, {
                rotation: 0,
                frameRate: recordingFrameRate
            });

            await recordingOutput.start();

            recordingEncoder = new VideoEncoder({
                output: (chunk, meta) => {
                    const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                    const packetWrite = recordingVideoSource?.add(encodedPacket, meta);
                    if (packetWrite) {
                        trackRecordingPacketWrite(packetWrite);
                    }
                },
                error: (error) => {
                    recordingEncoderError = error;
                }
            });

            recordingEncoder.configure({
                codec: recordingFormat.codecString,
                width,
                height,
                bitrate: recordingBitrate
            });

            recordingCanvas = document.createElement('canvas');
            recordingCanvas.width = width;
            recordingCanvas.height = height;
            recordingContext = recordingCanvas.getContext('2d', { alpha: false });
            if (!recordingContext) {
                throw new Error('Failed to create recording canvas');
            }

            recording = true;
            recordingFrameIndex = 0;
            startRecordingUpdate();
            captureRecordingFrame();

        } catch (error) {
            resetRecordingState();

            await events.invoke('showPopup', {
                type: 'error',
                header: localize('panel.render.failed'),
                message: `'${(error as Error).message ?? error}'`
            });
            return false;
        }

        return true;
    });

    events.function('record.video.stop', async () => {
        if (!recording || recordingStopping) {
            return false;
        }

        recordingStopping = true;
        recording = false;
        stopRecordingUpdate();
        stopCameraInteraction();
        stopRecordingUi();

        try {
            if (recordingEncoder) {
                await withTimeout(recordingEncoder.flush(), recordingFinalizeTimeout, 'Recording encoder did not finish in time.');
            }

            if (recordingPacketWrites.size > 0) {
                await withTimeout(Promise.all([...recordingPacketWrites]), recordingFinalizeTimeout, 'Recording packets did not finish writing in time.');
            }

            if (recordingEncoderError) {
                throw recordingEncoderError;
            }

            if (recordingOutput) {
                await withTimeout(recordingOutput.finalize(), recordingFinalizeTimeout, 'Recording file did not finish in time.');
            }

            if (recordingTarget && recordingFormat) {
                downloadFile(recordingTarget.buffer, getSceneFilename(recordingFormat.extension));
            }
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('panel.render.failed'),
                message: localize('popup.record-video.stop-failed')
            });
        } finally {
            resetRecordingState();
        }

        return true;
    });

    events.function('record.video.toggle', () => {
        return recording ?
            events.invoke('record.video.stop') :
            events.invoke('record.video.start');
    });

    events.function('render.offscreen', async (width: number, height: number): Promise<Uint8Array> => {
        try {
            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = false;
            scene.gizmoLayer.enabled = false;

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { mainTarget, workTarget } = scene.camera;

            scene.dataProcessor.copyRt(mainTarget, workTarget);

            // read the rendered frame
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

            // flip y positions to have 0,0 at the top
            let line = new Uint8Array(width * 4);
            for (let y = 0; y < height / 2; y++) {
                line = data.slice(y * width * 4, (y + 1) * width * 4);
                data.copyWithin(y * width * 4, (height - y - 1) * width * 4, (height - y) * width * 4);
                data.set(line, (height - y - 1) * width * 4);
            }

            return data;
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.camera.clearColor.set(0, 0, 0, 0);
        }
    });

    events.function('render.image', async (imageSettings: ImageSettings) => {
        events.fire('startSpinner');

        try {
            const { width, height, transparentBg, showDebug } = imageSettings;
            const bgClr = events.invoke('bgClr');

            // start rendering to offscreen buffer only
            scene.camera.startOffscreenMode(width, height);
            scene.camera.renderOverlays = showDebug;
            scene.gizmoLayer.enabled = false;
            if (!transparentBg) {
                scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
            }

            // render the next frame
            scene.forceRender = true;

            // for render to finish
            await postRender();

            // cpu-side buffer to read pixels into
            const data = new Uint8Array(width * height * 4);

            const { mainTarget, workTarget } = scene.camera;

            scene.dataProcessor.copyRt(mainTarget, workTarget);

            // read the rendered frame
            await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

            // construct the png compressor
            if (!compressor) {
                compressor = new PngCompressor();
            }

            const arrayBuffer = await compressor.compress(
                new Uint32Array(data.buffer),
                width,
                height
            );

            // construct filename
            const selected = events.invoke('selection') as Splat;
            const filename = `${removeExtension(selected?.name ?? 'SplatForge')}-image.png`;

            // download
            downloadFile(arrayBuffer, filename);

            return true;
        } catch (error) {
            await events.invoke('showPopup', {
                type: 'error',
                header: localize('panel.render.failed'),
                message: `'${error.message ?? error}'`
            });
        } finally {
            scene.camera.endOffscreenMode();
            scene.camera.renderOverlays = true;
            scene.gizmoLayer.enabled = true;
            scene.camera.clearPass.setClearColor(nullClr);

            events.fire('stopSpinner');
        }
    });

    events.function('render.video', (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream) => {
        const renderImpl = async () => {
            events.fire('progressStart', localize('panel.render.render-video'), true);

            let cancelled = false;
            const cancelHandler = events.on('progressCancel', () => {
                cancelled = true;
            });

            let encoder: VideoEncoder | null = null;

            try {
                const { startFrame, endFrame, frameRate, width, height, bitrate, transparentBg, showDebug, format, codec: codecChoice } = videoSettings;

                const target = fileStream ? new StreamTarget(fileStream) : new BufferTarget();

                // Configure output format and codec from lookup maps (default to mp4/h264)
                const formatConfig = FORMAT_CONFIG[format] ?? FORMAT_CONFIG.mp4;
                const outputFormat = formatConfig.create(!!fileStream);
                const fileExtension = formatConfig.extension;

                const codecConfig = CODEC_CONFIG[codecChoice] ?? CODEC_CONFIG.h264;
                const codecType = codecConfig.type;
                const codec = codecConfig.codec(height);

                const output = new Output({
                    format: outputFormat,
                    target
                });

                const videoSource = new EncodedVideoPacketSource(codecType);
                output.addVideoTrack(videoSource, {
                    rotation: 0,
                    frameRate
                });

                await output.start();

                let encoderError: Error | null = null;

                // helper to create and configure a VideoEncoder instance
                const createEncoder = () => {
                    encoderError = null;
                    const enc = new VideoEncoder({
                        output: async (chunk, meta) => {
                            const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                            await videoSource.add(encodedPacket, meta);
                        },
                        error: (error) => {
                            encoderError = error;
                        }
                    });
                    enc.configure({ codec, width, height, bitrate });
                    return enc;
                };

                encoder = createEncoder();

                // start rendering to offscreen buffer only
                scene.camera.startOffscreenMode(width, height);
                scene.camera.renderOverlays = showDebug;
                scene.gizmoLayer.enabled = false;
                if (!transparentBg) {
                    scene.camera.clearPass.setClearColor(events.invoke('bgClr'));
                }
                scene.lockedRenderMode = true;

                // cpu-side buffer to read pixels into
                const data = new Uint8Array(width * height * 4);
                const line = new Uint8Array(width * 4);

                // remember last camera position so we can skip sorting if the camera didn't move
                const last_pos = new Vec3(0, 0, 0);
                const last_forward = new Vec3(1, 0, 0);

                // helper to sort splats and wait for completion
                const sortAndWait = (splats: Splat[]) => {
                    return Promise.all(splats.map((splat) => {
                        return new Promise<void>((resolve) => {
                            const { instance } = splat.entity.gsplat;
                            instance.sorter.once('updated', resolve);
                            instance.sort(scene.camera.mainCamera);
                            setTimeout(resolve, 1000);
                        });
                    }));
                };

                // prepare the frame for rendering, returns the newly loaded splat if any
                const prepareFrame = async (frameTime: number): Promise<Splat | null> => {
                    // Fire timeline.time for camera animation interpolation
                    events.fire('timeline.time', frameTime);

                    // Wait for PLY sequence to load the frame if present
                    const newSplat = await events.invoke('plysequence.setFrameAsync', Math.floor(frameTime)) as Splat | null;

                    // manually update the camera so position and rotation are correct
                    scene.camera.onUpdate(0);

                    // If a new PLY was loaded, sort and wait for completion
                    if (newSplat) {
                        await sortAndWait([newSplat]);
                    } else {
                        // No new PLY - sort existing splats if camera moved
                        const pos = scene.camera.position;
                        const forward = scene.camera.forward;
                        if (!last_pos.equals(pos) || !last_forward.equals(forward)) {
                            last_pos.copy(pos);
                            last_forward.copy(forward);

                            const splats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                            await sortAndWait(splats);
                        }
                    }

                    return newSplat;
                };

                // capture the current video frame
                const captureFrame = async (frameTime: number) => {
                    const { mainTarget, workTarget } = scene.camera;

                    scene.dataProcessor.copyRt(mainTarget, workTarget);

                    // read the rendered frame
                    await workTarget.colorBuffer.read(0, 0, width, height, { renderTarget: workTarget, data });

                    // flip the buffer vertically
                    for (let y = 0; y < height / 2; y++) {
                        const top = y * width * 4;
                        const bottom = (height - y - 1) * width * 4;
                        line.set(data.subarray(top, top + width * 4));
                        data.copyWithin(top, bottom, bottom + width * 4);
                        data.set(line, bottom);
                    }

                    // construct the video frame
                    const videoFrame = new VideoFrame(data, {
                        format: 'RGBA',
                        codedWidth: width,
                        codedHeight: height,
                        timestamp: Math.floor(1e6 * frameTime),
                        duration: Math.floor(1e6 / frameRate)
                    });

                    // wait for encoder queue to drain if necessary (backpressure handling)
                    while (encoder.encodeQueueSize > 5) {
                        await new Promise<void>((resolve) => {
                            setTimeout(resolve, 1);
                        });
                    }

                    // if the codec was reclaimed (e.g. browser backgrounded the tab),
                    // recreate the encoder and continue
                    let forceKeyFrame = false;
                    if (encoder.state === 'closed' && encoderError?.message?.includes('reclaimed')) {
                        encoder = createEncoder();
                        forceKeyFrame = true;
                    }

                    // check for non-recoverable encoder errors
                    if (encoderError) {
                        videoFrame.close();
                        throw encoderError;
                    }

                    encoder.encode(videoFrame, { keyFrame: forceKeyFrame });
                    videoFrame.close();
                };

                const animFrameRate = events.invoke('timeline.frameRate');
                const duration = (endFrame - startFrame) / animFrameRate;

                for (let frameTime = 0; frameTime <= duration; frameTime += 1.0 / frameRate) {
                    // check for cancellation
                    if (cancelled) break;

                    // prepare the frame (loads PLY if needed, updates camera, sorts)
                    await prepareFrame(startFrame + frameTime * animFrameRate);

                    // render a frame
                    scene.lockedRender = true;

                    // wait for render to finish
                    await postRender();

                    // wait for capture
                    await captureFrame(frameTime);

                    events.fire('progressUpdate', {
                        text: localize('panel.render.rendering', { ellipsis: true }),
                        progress: 100 * frameTime / duration
                    });
                }

                // Flush and finalize output
                await encoder.flush();
                await output.finalize();

                // Download (skip if cancelled -- the caller will delete the file)
                if (!cancelled && !fileStream) {
                    const currentSplats = (scene.getElementsByType(ElementType.splat) as Splat[]).filter(splat => splat.visible);
                    downloadFile((output.target as BufferTarget).buffer, `${removeExtension(currentSplats[0]?.name ?? 'splatforge')}.${fileExtension}`);
                }

                return !cancelled;
            } catch (error) {
                await events.invoke('showPopup', {
                    type: 'error',
                    header: localize('panel.render.failed'),
                    message: `'${(error as any).message ?? error}'`
                });
                return false;
            } finally {
                if (encoder && encoder.state !== 'closed') {
                    encoder.close();
                }
                cancelHandler.off();

                scene.camera.endOffscreenMode();
                scene.camera.renderOverlays = true;
                scene.gizmoLayer.enabled = true;
                scene.camera.clearPass.setClearColor(nullClr);
                scene.lockedRenderMode = false;
                scene.forceRender = true;       // camera likely moved, finish with normal render

                events.fire('progressEnd');
            }
        };

        // Acquire a Web Lock during encoding to signal the browser that this tab is
        // actively working, which helps prevent aggressive background throttling and
        // codec reclamation.
        if (navigator.locks) {
            return navigator.locks.request('splatforge-video-render', renderImpl);
        }
        return renderImpl();
    });
};

export { ImageSettings, VideoSettings, registerRenderEvents };
