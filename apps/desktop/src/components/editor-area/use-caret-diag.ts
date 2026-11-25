import { useEffect, useState } from "react";
import {
  caretDiagStatus,
  loadCaretDiag,
  subscribeCaretDiag,
  type CaretDiagStatus,
} from "@/lib/caret-diag-log";

export function useCaretDiag(): CaretDiagStatus {
  const [state, setState] = useState(caretDiagStatus);
  useEffect(() => subscribeCaretDiag(setState), []);
  useEffect(() => {
    void loadCaretDiag();
  }, []);
  return state;
}
