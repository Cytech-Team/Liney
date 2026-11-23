export type CallAudioDevice = {
  id: string;
  name: string;
  description?: string;
  kind?: "input" | "output";
  isDefault?: boolean;
};

const GENERIC_DEVICE_NAME = /^(default|sysdefault|pipewire|pulse)$/i;
const DISPLAY_OUTPUT = /\b(hdmi|displayport|display port|dp)\b/i;
const COMMUNICATION_OUTPUT = /usb|headset|headphone|earphone|speakerphone/i;

export function isDisplayOutput(device: CallAudioDevice): boolean {
  return DISPLAY_OUTPUT.test(`${device.name} ${device.description ?? ""}`);
}

/**
 * Pick the call speaker.
 *
 * `saved === undefined` means the user has no manual choice yet. In that case
 * prefer a headset/speakerphone over the system default: on PipeWire systems
 * the default sink is frequently an HDMI monitor, so a call that follows the
 * default is silent even though the audio pipeline is healthy.
 *
 * `saved === ""` is an explicit "use system default" choice. A saved device id
 * wins while the device still exists.
 */
export function chooseCallOutput(devices: CallAudioDevice[], saved?: string): string {
  const outputs = devices.filter((device) => device.id && (device.kind ?? "output") === "output");
  if (!outputs.length) return "";

  if (saved !== undefined) {
    if (!saved) return "";
    const exact = outputs.find((device) => device.id === saved || device.name === saved);
    if (exact) return exact.id;
  }

  const inputs = devices.filter((device) => device.id && (device.kind ?? "input") === "input");
  const defaultInput = inputs.find((device) => device.isDefault) ?? inputs[0];
  if (defaultInput && !GENERIC_DEVICE_NAME.test(defaultInput.name)) {
    const paired = outputs.find((device) =>
      (device.name && device.name === defaultInput.name)
      || (device.description && defaultInput.description && device.description === defaultInput.description)
    );
    if (paired) return paired.id;
  }

  const communication = outputs.find((device) =>
    COMMUNICATION_OUTPUT.test(`${device.name} ${device.description ?? ""}`)
    && !isDisplayOutput(device)
  );
  return communication?.id ?? "";
}
