import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  ModalDialog,
  Text,
  TextInput,
  useWindowSize,
} from "silvery";
import {
  type PhonePairing,
  type PhonePairingEvent,
  startPhonePairing,
} from "../phone-pairing";
import { colors } from "../ui/theme";

export function ConnectPhoneDialog({
  onClose,
  startPairing = startPhonePairing,
}: {
  onClose(): void;
  startPairing?: typeof startPhonePairing;
}) {
  const [event, setEvent] = useState<PhonePairingEvent>({
    type: "status",
    message: "Checking Tailscale...",
  });
  const [attempt, setAttempt] = useState(0);
  const [code, setCode] = useState("");
  const pairing = useRef<PhonePairing | null>(null);
  const { columns, rows } = useWindowSize();
  useEffect(() => {
    setCode("");
    setEvent({ type: "status", message: "Checking Tailscale..." });
    const connection = startPairing(setEvent);
    pairing.current = connection;
    return () => {
      pairing.current = null;
      connection.close();
    };
  }, [attempt]);
  useEffect(() => {
    if (event.type !== "qr") {
      return;
    }
    const timer = setTimeout(
      () => {
        pairing.current?.close();
        setEvent({
          type: "error",
          message:
            "This QR code expired. Generate a new code to pair your phone.",
        });
      },
      Math.max(1, event.expiresAt - Date.now())
    );
    return () => clearTimeout(timer);
  }, [event]);
  const qrRows = event.type === "qr" ? event.art.trimEnd().split("\n") : [];
  const qrWidth = Math.max(0, ...qrRows.map((line) => line.length));
  const width = Math.min(columns - 4, Math.max(64, qrWidth + 6));
  const fits = qrWidth <= width - 6 && qrRows.length + 10 <= rows;
  return (
    <Box
      alignItems="center"
      height="100%"
      justifyContent="center"
      left={0}
      onMouseDown={onClose}
      position="absolute"
      top={0}
      width="100%"
    >
      <Box onMouseDown={(mouse) => mouse.stopPropagation()}>
        <ModalDialog
          borderColor={colors.borderFocus}
          footer="Esc close"
          onClose={onClose}
          title="Connect phone"
          titleColor={colors.accentAlt}
          width={width}
        >
          {event.type === "status" ? (
            <Text color={colors.text}>{event.message}</Text>
          ) : null}
          {event.type === "qr" ? (
            <Box flexDirection="column" gap={1}>
              <Text color={colors.text}>
                Tailscale is ready. Scan in Workbench on your iPhone.
              </Text>
              <Text color={colors.dim}>
                Both devices must use the same Tailscale network.
              </Text>
              {fits ? (
                <Box alignItems="center" flexDirection="column">
                  <Box
                    backgroundColor="#000000"
                    flexDirection="column"
                    paddingX={2}
                    paddingY={1}
                  >
                    {qrRows.map((line, index) => (
                      <Text color="#ffffff" key={index} wrap={false}>
                        {line}
                      </Text>
                    ))}
                  </Box>
                </Box>
              ) : (
                <Text
                  color={colors.text}
                >{`Enlarge this terminal to at least ${qrWidth + 10} columns and ${qrRows.length + 10} rows to show the full QR code.`}</Text>
              )}
              <Text color={colors.dim}>
                This private code expires in five minutes.
              </Text>
            </Box>
          ) : null}
          {event.type === "approval" ? (
            <Box flexDirection="column" gap={1}>
              <Text
                color={colors.text}
              >{`${event.device} requested access.`}</Text>
              <Text color={colors.dim}>
                Enter the six-digit code shown on your iPhone.
              </Text>
              <TextInput
                isActive
                onChange={setCode}
                onSubmit={(value) => {
                  if (/^\d{6}$/.test(value)) {
                    pairing.current?.approve(value);
                    setEvent({
                      type: "status",
                      message: "Approving your iPhone...",
                    });
                  }
                }}
                placeholder="Six-digit code"
                value={code}
              />
            </Box>
          ) : null}
          {event.type === "paired" ? (
            <Text color={colors.text}>
              Phone connected. Your sessions are ready in the app.
            </Text>
          ) : null}
          {event.type === "error" ? (
            <Box flexDirection="column" gap={1}>
              <Text color={colors.text}>{event.message}</Text>
              <Button
                label="Try again"
                onPress={() => setAttempt((value) => value + 1)}
              />
            </Box>
          ) : null}
          {event.type === "paired" ? (
            <Button label="Done" onPress={onClose} />
          ) : null}
        </ModalDialog>
      </Box>
    </Box>
  );
}
