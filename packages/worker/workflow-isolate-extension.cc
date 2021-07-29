#include <cassert>
#include <nan.h>
#include <isolated_vm.h>

using namespace v8;

#define EMBEDDER_DATA_IDX 0

const char* promise_hook_type_to_str(PromiseHookType type) {
    switch(type) {
        case PromiseHookType::kInit:
            return "init";
        case PromiseHookType::kResolve:
            return "resolve";
        case PromiseHookType::kBefore:
            return "before";
        case PromiseHookType::kAfter:
            return "after";
        default:
            return "unknown";
    }
}

void custom_promise_hook(
    PromiseHookType type,
    Local<Promise> promise,
    Local<Value> parent
) {
#if V8_AT_LEAST(9, 0, 0)
    Local<Context> context = promise->GetCreationContext().ToLocalChecked();
#else
    Local<Context> context = promise->CreationContext();
#endif
    Local<Function> fn = Local<Function>::Cast(context->GetEmbedderData(EMBEDDER_DATA_IDX));

    const unsigned argc = 3;
    auto hook_type_str = promise_hook_type_to_str(type);
    Local<Value> argv[argc] = {Nan::New(hook_type_str).ToLocalChecked(), promise, parent};
    auto result = fn->Call(context, Local<Object>::Cast(Nan::Undefined()), argc, argv);
    assert(!result.IsEmpty());
}

NAN_METHOD(register_promise_hook) {
    auto isolate = Isolate::GetCurrent();
    auto ctx = isolate->GetCurrentContext();
    ctx->SetEmbedderData(EMBEDDER_DATA_IDX, info[0]);
    isolate->SetPromiseHook(custom_promise_hook);
    info.GetReturnValue().Set(Nan::Undefined());
}

NAN_METHOD(set_promise_data) {
    Local<Object>::Cast(info[0])->SetInternalField(0, info[1]);
    info.GetReturnValue().Set(Nan::Undefined());
}

NAN_METHOD(get_promise_data) {
    info.GetReturnValue().Set(Local<Object>::Cast(info[0])->GetInternalField(0));
}

ISOLATED_VM_MODULE void InitForContext(Isolate* isolate, Local<Context> context, Local<Object> target) {
    Nan::Set(target, Nan::New("registerPromiseHook").ToLocalChecked(), Nan::GetFunction(Nan::New<FunctionTemplate>(register_promise_hook)).ToLocalChecked());
    Nan::Set(target, Nan::New("setPromiseData").ToLocalChecked(), Nan::GetFunction(Nan::New<FunctionTemplate>(set_promise_data)).ToLocalChecked());
    Nan::Set(target, Nan::New("getPromiseData").ToLocalChecked(), Nan::GetFunction(Nan::New<FunctionTemplate>(get_promise_data)).ToLocalChecked());
}
