import { condition, defineSignal, setDefaultQueryHandler, setDefaultSignalHandler, setHandler } from "@temporalio/workflow";

export async function workflowWithDefaultHandlers() {
    let complete = true;
    setDefaultQueryHandler(() => {});
    setDefaultSignalHandler(() => {});
    setHandler(defineSignal('completeSignal'), () => {});

    condition(() => complete);
}