import { useState, type ReactNode } from "react";
import { editorUnlocked } from "@/lib/account-gate";
import { AGE_INVALID, ageAnswer, ageState, rememberUnderAge, type AgeState } from "@/lib/age-gate";
import { SignInScreen } from "./sign-in-screen";
import { useSignInGate } from "./use-sign-in-gate";

/** Full-window sign-in. The desk mounts only after a session is signed in. */
export function SignInGate({ children }: { children: ReactNode }) {
  const gate = useSignInGate();
  const [age, setAge] = useState<AgeState>(() => ageState());
  const [birthDate, setBirthDate] = useState("");
  const [ageError, setAgeError] = useState<string | null>(null);
  if (!gate.ready) return null;
  if (editorUnlocked(gate.hasSession, gate.step)) return children;
  const step = gate.step === "desk" ? "welcome" : gate.step;

  /** The date step. A date that is not one is caught here; the server decides the rest. */
  function submitAge() {
    if (ageAnswer(birthDate, new Date()) === "invalid") {
      setAgeError(AGE_INVALID);
      return;
    }
    setAgeError(null);
    void gate.submitAge(birthDate).then((result) => {
      // The server refused the date and erased the held sign-in.
      if (result === "age_blocked") {
        rememberUnderAge();
        setAge("blocked");
      }
    });
  }

  return (
    <SignInScreen
      key={step}
      step={step}
      age={age}
      birthDate={birthDate}
      onBirthDate={(value) => {
        setBirthDate(value);
        setAgeError(null);
      }}
      email={gate.email}
      error={ageError ?? gate.error}
      busy={gate.busy}
      resendIn={gate.resendIn}
      onEmail={gate.setEmail}
      onContinue={() => void gate.sendCode()}
      onResend={() => void gate.sendCode()}
      onDifferentEmail={() => {
        setAgeError(null);
        gate.differentEmail();
      }}
      onSubmitCode={(code) => void gate.submitCode(code)}
      onSubmitAge={submitAge}
    />
  );
}
