use cpal::traits::{DeviceTrait as CpalDeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SampleRate, SizedSample};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{sync_channel, SyncSender},
    Arc, Mutex,
};
use std::time::Duration;

fn media_call_tone_envelope(time: f32, start: f32, duration: f32) -> f32 {
    if time < start || time >= start + duration {
        return 0.0;
    }
    let local = time - start;
    let edge = 0.018_f32;
    let attack = (local / edge).clamp(0.0, 1.0);
    let release = ((duration - local) / edge).clamp(0.0, 1.0);
    attack.min(release)
}

fn media_call_tone_sample(mode: &str, time: f32) -> f32 {
    use std::f32::consts::TAU;
    let (cycle, segments): (f32, &[(f32, f32, f32, f32, f32)]) = if mode == "incoming" {
        (
            2.75,
            &[
                (0.00, 0.22, 659.25, 783.99, 0.20),
                (0.28, 0.28, 783.99, 987.77, 0.22),
                (0.82, 0.22, 659.25, 783.99, 0.18),
                (1.10, 0.32, 783.99, 987.77, 0.22),
            ],
        )
    } else {
        (3.40, &[(0.0, 1.05, 425.0, 480.0, 0.18)])
    };
    let phase = time % cycle;
    let mut value = 0.0_f32;
    for (start, duration, f1, f2, volume) in segments {
        let envelope = media_call_tone_envelope(phase, *start, *duration);
        if envelope <= 0.0 {
            continue;
        }
        let chord = ((TAU * *f1 * time).sin() + (TAU * *f2 * time).sin()) * 0.5;
        value += chord * *volume * envelope;
    }
    value.clamp(-0.92, 0.92)
}

fn run_media_call_tone_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mode: String,
) -> Result<(), String>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    let sample_rate = config.sample_rate.0 as f32;
    let channels = config.channels as usize;
    let mut sample_index: u64 = 0;
    let stream = device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                for frame in output.chunks_mut(channels) {
                    let time = sample_index as f32 / sample_rate;
                    let value = media_call_tone_sample(&mode, time);
                    sample_index += 1;
                    let sample = T::from_sample(value);
                    for channel in frame.iter_mut() {
                        *channel = sample;
                    }
                }
            },
            |error| eprintln!("Liney call tone stream error: {error}"),
            None,
        )
        .map_err(|error| format!("cannot create Liney call tone stream: {error}"))?;
    stream
        .play()
        .map_err(|error| format!("cannot start Liney call tone stream: {error}"))?;
    loop {
        std::thread::sleep(Duration::from_secs(60));
    }
}

fn run_media_call_tone(mode: String) -> Result<(), String> {
    if mode != "incoming" && mode != "outgoing" {
        return Err("call tone mode must be incoming or outgoing".into());
    }
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "no default audio output device".to_string())?;
    let supported = device
        .default_output_config()
        .map_err(|error| format!("cannot query default audio output: {error}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    match sample_format {
        SampleFormat::I8 => run_media_call_tone_stream::<i8>(&device, &config, mode),
        SampleFormat::I16 => run_media_call_tone_stream::<i16>(&device, &config, mode),
        SampleFormat::I32 => run_media_call_tone_stream::<i32>(&device, &config, mode),
        SampleFormat::I64 => run_media_call_tone_stream::<i64>(&device, &config, mode),
        SampleFormat::U8 => run_media_call_tone_stream::<u8>(&device, &config, mode),
        SampleFormat::U16 => run_media_call_tone_stream::<u16>(&device, &config, mode),
        SampleFormat::U32 => run_media_call_tone_stream::<u32>(&device, &config, mode),
        SampleFormat::U64 => run_media_call_tone_stream::<u64>(&device, &config, mode),
        SampleFormat::F32 => run_media_call_tone_stream::<f32>(&device, &config, mode),
        SampleFormat::F64 => run_media_call_tone_stream::<f64>(&device, &config, mode),
        other => Err(format!("unsupported Liney call tone sample format: {other}")),
    }
}

fn parse_call_tone_mode(mut args: impl Iterator<Item = String>) -> Result<String, String> {
    let mut mode: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--mode" => {
                mode = Some(args.next().ok_or_else(|| "--mode requires a value".to_string())?);
            }
            other => return Err(format!("unknown call tone option: {other}")),
        }
    }
    mode.ok_or_else(|| "--mode is required".to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioDeviceInfo {
    id: String,
    name: String,
    description: String,
    kind: &'static str,
    is_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioDeviceList {
    backend: &'static str,
    inputs: Vec<AudioDeviceInfo>,
    outputs: Vec<AudioDeviceInfo>,
}

fn cpal_device_name(device: &cpal::Device) -> String {
    CpalDeviceTrait::name(device).unwrap_or_else(|_| "Unknown audio device".to_string())
}

fn list_cpal_devices() -> AudioDeviceList {
    let host = cpal::default_host();
    let default_input_name = host.default_input_device().map(|device| cpal_device_name(&device));
    let default_output_name = host.default_output_device().map(|device| cpal_device_name(&device));

    let inputs = host
        .input_devices()
        .map(|devices| {
            devices
                .enumerate()
                .map(|(index, device)| {
                    let name = cpal_device_name(&device);
                    AudioDeviceInfo {
                        id: format!("input:{index}"),
                        description: name.clone(),
                        is_default: default_input_name.as_deref() == Some(name.as_str()),
                        name,
                        kind: "input",
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let outputs = host
        .output_devices()
        .map(|devices| {
            devices
                .enumerate()
                .map(|(index, device)| {
                    let name = cpal_device_name(&device);
                    AudioDeviceInfo {
                        id: format!("output:{index}"),
                        description: name.clone(),
                        is_default: default_output_name.as_deref() == Some(name.as_str()),
                        name,
                        kind: "output",
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    AudioDeviceList {
        backend: "cpal-system-default",
        inputs,
        outputs,
    }
}

fn parse_audio_device_id(value: Option<String>, expected_kind: &str) -> Result<Option<usize>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() || value == "default" {
        return Ok(None);
    }
    let Some((kind, index)) = value.split_once(':') else {
        return Err("invalid audio device id".into());
    };
    if kind != expected_kind {
        return Err(format!("audio device {value} is not a {expected_kind} device"));
    }
    let index = index
        .parse::<usize>()
        .map_err(|_| "invalid audio device index".to_string())?;
    Ok(Some(index))
}

fn parse_audio_device_option(mut args: impl Iterator<Item = String>, expected_kind: &str) -> Result<Option<usize>, String> {
    let mut device_id: Option<String> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--device" => {
                device_id = Some(
                    args.next()
                        .ok_or_else(|| "--device requires an id".to_string())?,
                );
            }
            other => return Err(format!("unknown audio helper option: {other}")),
        }
    }
    parse_audio_device_id(device_id, expected_kind)
}

fn resolve_cpal_device(kind: &str, index: Option<usize>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(index) = index {
        let mut devices = if kind == "input" {
            host.input_devices()
                .map_err(|error| format!("cannot enumerate input devices: {error}"))?
        } else {
            host.output_devices()
                .map_err(|error| format!("cannot enumerate output devices: {error}"))?
        };
        return devices
            .nth(index)
            .ok_or_else(|| format!("{kind} device {index} is unavailable"));
    }
    if kind == "input" {
        host.default_input_device()
            .ok_or_else(|| "no default microphone is available".to_string())
    } else {
        host.default_output_device()
            .ok_or_else(|| "no default speaker is available".to_string())
    }
}

fn choose_audio_config(device: &cpal::Device, kind: &str) -> Result<cpal::SupportedStreamConfig, String> {
    let preferred_rate = SampleRate(48_000);
    let configs = if kind == "input" {
        device
            .supported_input_configs()
            .map_err(|error| format!("cannot query microphone formats: {error}"))?
            .collect::<Vec<_>>()
    } else {
        device
            .supported_output_configs()
            .map_err(|error| format!("cannot query speaker formats: {error}"))?
            .collect::<Vec<_>>()
    };

    let mut exact = configs
        .into_iter()
        .filter_map(|range| range.try_with_sample_rate(preferred_rate))
        .collect::<Vec<_>>();
    exact.sort_by_key(|config| {
        let channel_score = if config.channels() == 1 {
            0
        } else if config.channels() == 2 {
            1
        } else {
            2
        };
        let format_score = match config.sample_format() {
            SampleFormat::F32 => 0,
            SampleFormat::I16 => 1,
            _ => 2,
        };
        (channel_score, format_score)
    });
    if let Some(config) = exact.into_iter().next() {
        return Ok(config);
    }

    if kind == "input" {
        device
            .default_input_config()
            .map_err(|error| format!("cannot query default microphone format: {error}"))
    } else {
        device
            .default_output_config()
            .map_err(|error| format!("cannot query default speaker format: {error}"))
    }
}

fn push_input_samples<T>(
    data: &[T],
    channels: usize,
    source_rate: f32,
    phase: &mut f32,
    sender: &SyncSender<Vec<i16>>,
) where
    T: SizedSample + Copy,
    f32: FromSample<T>,
{
    if channels == 0 || source_rate <= 0.0 {
        return;
    }
    let ratio = 48_000.0 / source_rate;
    let mut output = Vec::with_capacity(((data.len() / channels) as f32 * ratio + 8.0) as usize);

    for frame in data.chunks(channels) {
        if frame.is_empty() {
            continue;
        }
        let mut mono = 0.0_f32;
        for sample in frame {
            mono += f32::from_sample(*sample);
        }
        mono /= frame.len() as f32;

        *phase += ratio;
        while *phase >= 1.0 {
            let pcm = (mono.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            output.push(pcm);
            *phase -= 1.0;
        }
    }

    if !output.is_empty() {
        let _ = sender.try_send(output);
    }
}

fn build_audio_input_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sender: SyncSender<Vec<i16>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Copy + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let source_rate = config.sample_rate.0 as f32;
    let mut phase = 0.0_f32;
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                push_input_samples(data, channels, source_rate, &mut phase, &sender);
            },
            |error| eprintln!("Liney native microphone stream error: {error}"),
            None,
        )
        .map_err(|error| format!("cannot create microphone stream: {error}"))
}

fn run_audio_input(device_index: Option<usize>) -> Result<(), String> {
    let device = resolve_cpal_device("input", device_index)?;
    let supported = choose_audio_config(&device, "input")?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.clone().into();
    eprintln!(
        "Liney media: microphone={} {}Hz {}ch {}",
        cpal_device_name(&device),
        config.sample_rate.0,
        config.channels,
        sample_format
    );

    let (sender, receiver) = sync_channel::<Vec<i16>>(8);
    let stream = match sample_format {
        SampleFormat::I8 => build_audio_input_stream::<i8>(&device, &config, sender),
        SampleFormat::I16 => build_audio_input_stream::<i16>(&device, &config, sender),
        SampleFormat::I32 => build_audio_input_stream::<i32>(&device, &config, sender),
        SampleFormat::I64 => build_audio_input_stream::<i64>(&device, &config, sender),
        SampleFormat::U8 => build_audio_input_stream::<u8>(&device, &config, sender),
        SampleFormat::U16 => build_audio_input_stream::<u16>(&device, &config, sender),
        SampleFormat::U32 => build_audio_input_stream::<u32>(&device, &config, sender),
        SampleFormat::U64 => build_audio_input_stream::<u64>(&device, &config, sender),
        SampleFormat::F32 => build_audio_input_stream::<f32>(&device, &config, sender),
        SampleFormat::F64 => build_audio_input_stream::<f64>(&device, &config, sender),
        other => Err(format!("unsupported microphone sample format: {other}")),
    }?;
    stream
        .play()
        .map_err(|error| format!("cannot start microphone stream: {error}"))?;

    let stdout = io::stdout();
    let mut stdout = stdout.lock();
    while let Ok(samples) = receiver.recv() {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        if stdout.write_all(&bytes).is_err() || stdout.flush().is_err() {
            break;
        }
    }
    drop(stream);
    Ok(())
}

fn fill_output_samples<T>(
    output: &mut [T],
    channels: usize,
    device_rate: f32,
    queue: &Arc<Mutex<VecDeque<f32>>>,
    phase: &mut f32,
    current: &mut f32,
    have_current: &mut bool,
) where
    T: SizedSample + FromSample<f32>,
{
    if channels == 0 || device_rate <= 0.0 {
        return;
    }
    let ratio = 48_000.0 / device_rate;
    let mut queue = match queue.lock() {
        Ok(queue) => queue,
        Err(_) => {
            for sample in output.iter_mut() {
                *sample = T::from_sample(0.0);
            }
            return;
        }
    };

    for frame in output.chunks_mut(channels) {
        if !*have_current {
            if let Some(sample) = queue.pop_front() {
                *current = sample;
                *have_current = true;
            } else {
                *current = 0.0;
            }
        }

        let converted = T::from_sample(*current);
        for channel in frame.iter_mut() {
            *channel = converted;
        }

        *phase += ratio;
        while *phase >= 1.0 {
            *phase -= 1.0;
            if let Some(sample) = queue.pop_front() {
                *current = sample;
                *have_current = true;
            } else {
                *current = 0.0;
                *have_current = false;
                break;
            }
        }
    }
}

fn build_audio_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    queue: Arc<Mutex<VecDeque<f32>>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32> + Send + 'static,
{
    let channels = config.channels as usize;
    let device_rate = config.sample_rate.0 as f32;
    let mut phase = 0.0_f32;
    let mut current = 0.0_f32;
    let mut have_current = false;
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
                fill_output_samples(
                    output,
                    channels,
                    device_rate,
                    &queue,
                    &mut phase,
                    &mut current,
                    &mut have_current,
                );
            },
            |error| eprintln!("Liney native speaker stream error: {error}"),
            None,
        )
        .map_err(|error| format!("cannot create speaker stream: {error}"))
}

fn run_audio_output(device_index: Option<usize>) -> Result<(), String> {
    let device = resolve_cpal_device("output", device_index)?;
    let supported = choose_audio_config(&device, "output")?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.clone().into();
    eprintln!(
        "Liney media: speaker={} {}Hz {}ch {}",
        cpal_device_name(&device),
        config.sample_rate.0,
        config.channels,
        sample_format
    );

    let queue = Arc::new(Mutex::new(VecDeque::<f32>::with_capacity(48_000)));
    let stream = match sample_format {
        SampleFormat::I8 => build_audio_output_stream::<i8>(&device, &config, queue.clone()),
        SampleFormat::I16 => build_audio_output_stream::<i16>(&device, &config, queue.clone()),
        SampleFormat::I32 => build_audio_output_stream::<i32>(&device, &config, queue.clone()),
        SampleFormat::I64 => build_audio_output_stream::<i64>(&device, &config, queue.clone()),
        SampleFormat::U8 => build_audio_output_stream::<u8>(&device, &config, queue.clone()),
        SampleFormat::U16 => build_audio_output_stream::<u16>(&device, &config, queue.clone()),
        SampleFormat::U32 => build_audio_output_stream::<u32>(&device, &config, queue.clone()),
        SampleFormat::U64 => build_audio_output_stream::<u64>(&device, &config, queue.clone()),
        SampleFormat::F32 => build_audio_output_stream::<f32>(&device, &config, queue.clone()),
        SampleFormat::F64 => build_audio_output_stream::<f64>(&device, &config, queue.clone()),
        other => Err(format!("unsupported speaker sample format: {other}")),
    }?;
    stream
        .play()
        .map_err(|error| format!("cannot start speaker stream: {error}"))?;

    let eof = Arc::new(AtomicBool::new(false));
    let eof_reader = eof.clone();
    let queue_reader = queue.clone();
    let reader = std::thread::Builder::new()
        .name("liney-native-audio-reader".to_string())
        .spawn(move || {
            let stdin = io::stdin();
            let mut stdin = stdin.lock();
            let mut bytes = [0_u8; 4096];
            let mut carry: Option<u8> = None;
            loop {
                let read = match stdin.read(&mut bytes) {
                    Ok(0) => break,
                    Ok(read) => read,
                    Err(_) => break,
                };
                let mut values = Vec::with_capacity(read / 2 + 1);
                let mut index = 0;

                if let Some(first) = carry.take() {
                    if read > 0 {
                        let sample = i16::from_le_bytes([first, bytes[0]]);
                        values.push(sample as f32 / i16::MAX as f32);
                        index = 1;
                    } else {
                        carry = Some(first);
                    }
                }

                while index + 1 < read {
                    let sample = i16::from_le_bytes([bytes[index], bytes[index + 1]]);
                    values.push(sample as f32 / i16::MAX as f32);
                    index += 2;
                }
                if index < read {
                    carry = Some(bytes[index]);
                }

                if let Ok(mut queue) = queue_reader.lock() {
                    for value in values {
                        queue.push_back(value);
                    }
                    while queue.len() > 96_000 {
                        queue.pop_front();
                    }
                }
            }
            eof_reader.store(true, Ordering::SeqCst);
        })
        .map_err(|error| error.to_string())?;

    loop {
        if eof.load(Ordering::SeqCst) {
            let empty = queue.lock().map(|queue| queue.is_empty()).unwrap_or(true);
            if empty {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = reader.join();
    std::thread::sleep(Duration::from_millis(40));
    drop(stream);
    Ok(())
}

pub fn maybe_run_from_args() -> Result<bool, String> {
    let mut args = std::env::args().skip(1);
    let Some(mode) = args.next() else {
        return Ok(false);
    };

    match mode.as_str() {
        "--liney-media-audio-devices" => {
            let devices = list_cpal_devices();
            println!(
                "{}",
                serde_json::to_string(&devices)
                    .map_err(|error| format!("cannot encode audio device list: {error}"))?
            );
            Ok(true)
        }
        "--liney-media-audio-input" => {
            let device = parse_audio_device_option(args, "input")?;
            run_audio_input(device)?;
            Ok(true)
        }
        "--liney-media-audio-output" => {
            let device = parse_audio_device_option(args, "output")?;
            run_audio_output(device)?;
            Ok(true)
        }
        "--liney-media-call-tone" => {
            let mode = parse_call_tone_mode(args)?;
            run_media_call_tone(mode)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}
