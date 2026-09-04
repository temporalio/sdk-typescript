using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Threading;
using Google.Protobuf.WellKnownTypes;
using Temporalio.Common;
using Temporalio.Converters;
using Temporalio.Workflows;
using ApiCommon = Temporalio.Api.Common.V1;
using ApiDeployment = Temporalio.Api.Deployment.V1;
using ApiFailure = Temporalio.Api.Failure.V1;
using ApiTaskQueue = Temporalio.Api.TaskQueue.V1;
using ApiWorkflow = Temporalio.Api.Workflow.V1;

namespace Nexgen.Support
{
    internal static class TemporalWorkflowContext
    {
        internal static string WorkflowNamespace() => Workflow.Info.Namespace;
    }

    internal static class TemporalFunctionNames
    {
        internal static (MethodInfo Method, IReadOnlyCollection<object?> Args) ExtractCall<TDelegate>(Expression<TDelegate> expression)
        {
            if (expression.Body is not MethodCallExpression call)
            {
                throw new ArgumentException("Expression must be a single method call", nameof(expression));
            }
            var method = call.Method;
            var args = call.Arguments.Select(arg => Expression.Lambda<Func<object?>>(Expression.Convert(arg, typeof(object))).Compile()()).ToArray();
            return (method, args);
        }

        internal static string WorkflowName(MethodInfo method)
        {
            if (method.GetCustomAttribute<WorkflowRunAttribute>() == null)
            {
                throw new ArgumentException($"{method} missing WorkflowRun attribute");
            }
            var definition = WorkflowDefinition.Create(method.ReflectedType ??
                throw new ArgumentException($"{method} has no reflected type"));
            return definition.Name ??
                throw new ArgumentException(
                    $"{method} cannot be used directly since it is a dynamic workflow");
        }

        internal static string SignalName(MethodInfo method)
        {
            var definition = WorkflowSignalDefinition.FromMethod(method);
            return definition.Name ??
                throw new ArgumentException(
                    $"{method} cannot be used directly since it is a dynamic signal");
        }
    }

    internal static class SystemNexusConverterContext
    {
        private static readonly AsyncLocal<ConverterContext?> CurrentLocal = new();

        internal static IPayloadConverter PayloadConverter => Current.PayloadConverter;

        internal static IFailureConverter FailureConverter => Current.FailureConverter;

        private static ConverterContext Current => CurrentLocal.Value ?? throw new InvalidOperationException(
            "The System Nexus converter context is only available while a System Nexus transfer type converter is executing.");

        internal static IDisposable Push(
            IPayloadConverter payloadConverter,
            IFailureConverter failureConverter)
        {
            var previous = CurrentLocal.Value;
            CurrentLocal.Value = new(payloadConverter, failureConverter);
            return new PopOnDispose(previous);
        }

        private sealed record ConverterContext(
            IPayloadConverter PayloadConverter,
            IFailureConverter FailureConverter);

        private sealed class PopOnDispose : IDisposable
        {
            private readonly ConverterContext? previous;
            private bool disposed;

            internal PopOnDispose(ConverterContext? previous) => this.previous = previous;

            public void Dispose()
            {
                if (!disposed)
                {
                    CurrentLocal.Value = previous;
                    disposed = true;
                }
            }
        }
    }

    internal static class ProtoExtensions
    {
        internal static ApiCommon.WorkflowType ToWorkflowTypeProto(this string value) =>
            new() { Name = value };

        internal static string FromWorkflowTypeProto(ApiCommon.WorkflowType value) =>
            value.Name;

        internal static ApiTaskQueue.TaskQueue ToTaskQueueProto(this string value) =>
            new() { Name = value };

        internal static string FromTaskQueueProto(ApiTaskQueue.TaskQueue value) =>
            value.Name;

        internal static ApiCommon.Payload ToPayload(object? value) =>
            SystemNexusConverterContext.PayloadConverter.ToPayload(value);

        internal static object? FromPayload(ApiCommon.Payload payload) =>
            SystemNexusConverterContext.PayloadConverter.ToValue<object?>(payload);

        internal static ApiCommon.Payloads ToPayloads(IEnumerable<object?> values)
        {
            var payloads = new ApiCommon.Payloads();
            payloads.Payloads_.AddRange(SystemNexusConverterContext.PayloadConverter.ToPayloads(values as IReadOnlyCollection<object?> ?? new List<object?>(values)));
            return payloads;
        }

        internal static IReadOnlyCollection<object?> FromPayloads(ApiCommon.Payloads payloads) =>
            payloads.Payloads_.Select(FromPayload).ToArray();

        internal static ApiFailure.Failure ToFailureProto(this Exception value) =>
            SystemNexusConverterContext.FailureConverter.ToFailure(
                value, SystemNexusConverterContext.PayloadConverter);

        internal static Exception FromFailureProto(ApiFailure.Failure value) =>
            SystemNexusConverterContext.FailureConverter.ToException(
                value, SystemNexusConverterContext.PayloadConverter);

        internal static Duration ToProto(this TimeSpan value) =>
            Duration.FromTimeSpan(value);

        internal static TimeSpan FromDurationProto(Duration value) =>
            value.ToTimeSpan();

        internal static ApiCommon.RetryPolicy ToProto(this Temporalio.Common.RetryPolicy value) =>
            ToRetryPolicy(value);

        internal static Temporalio.Common.RetryPolicy FromRetryPolicyProto(ApiCommon.RetryPolicy value) =>
            FromRetryPolicy(value);

        internal static ApiCommon.Memo ToProto(this IReadOnlyDictionary<string, object?> value) =>
            ToMemo(value);

        internal static IReadOnlyDictionary<string, object?> FromMemoProto(ApiCommon.Memo value) =>
            value.Fields.ToDictionary(
                item => item.Key,
                item => FromPayload(item.Value));

        internal static ApiCommon.Header ToHeaderProto(this IReadOnlyDictionary<string, object?> value)
        {
            var header = new ApiCommon.Header();
            foreach (var item in value)
            {
                header.Fields.Add(item.Key, ToPayload(item.Value));
            }
            return header;
        }

        internal static IReadOnlyDictionary<string, object?> FromHeaderProto(ApiCommon.Header value) =>
            value.Fields.ToDictionary(
                item => item.Key,
                item => FromPayload(item.Value));

        internal static ApiCommon.Priority ToProto(this Temporalio.Common.Priority value) =>
            ToPriority(value);

        internal static Temporalio.Common.Priority FromPriorityProto(ApiCommon.Priority value) =>
            new(
                value.PriorityKey == 0 ? null : value.PriorityKey,
                value.FairnessKey,
                value.FairnessWeight == 0 ? null : (float)value.FairnessWeight);

        internal static ApiWorkflow.VersioningOverride ToProto(this Temporalio.Common.VersioningOverride value) =>
            ToVersioningOverride(value);

        internal static Temporalio.Common.SearchAttributeCollection FromSearchAttributesProto(ApiCommon.SearchAttributes value) =>
            Temporalio.Common.SearchAttributeCollection.FromProto(value);

        internal static Temporalio.Common.VersioningOverride? FromVersioningOverrideProto(ApiWorkflow.VersioningOverride versioningOverride)
        {
            if (versioningOverride.AutoUpgrade)
            {
                return new Temporalio.Common.VersioningOverride.AutoUpgrade();
            }
            if (versioningOverride.Pinned is { } pinned)
            {
                return new Temporalio.Common.VersioningOverride.Pinned(
                    new Temporalio.Common.WorkerDeploymentVersion(
                        pinned.Version.DeploymentName,
                        pinned.Version.BuildId),
                    (Temporalio.Common.VersioningOverride.PinnedOverrideBehavior)pinned.Behavior);
            }
            return null;
        }

        private static ApiCommon.RetryPolicy ToRetryPolicy(Temporalio.Common.RetryPolicy policy)
        {
            var proto = new ApiCommon.RetryPolicy
            {
                InitialInterval = Duration.FromTimeSpan(policy.InitialInterval),
                BackoffCoefficient = policy.BackoffCoefficient,
                MaximumAttempts = policy.MaximumAttempts,
            };
            if (policy.MaximumInterval is { } maximumInterval)
            {
                proto.MaximumInterval = Duration.FromTimeSpan(maximumInterval);
            }
            if (policy.NonRetryableErrorTypes is { Count: > 0 } nonRetryableErrorTypes)
            {
                proto.NonRetryableErrorTypes.AddRange(nonRetryableErrorTypes);
            }
            return proto;
        }

        private static Temporalio.Common.RetryPolicy FromRetryPolicy(ApiCommon.RetryPolicy policy)
        {
            var retryPolicy = new Temporalio.Common.RetryPolicy
            {
                InitialInterval = policy.InitialInterval?.ToTimeSpan() ?? TimeSpan.FromSeconds(1),
                BackoffCoefficient = (float)policy.BackoffCoefficient,
                MaximumAttempts = policy.MaximumAttempts,
            };
            if (policy.MaximumInterval is { } maximumInterval)
            {
                retryPolicy.MaximumInterval = maximumInterval.ToTimeSpan();
            }
            if (policy.NonRetryableErrorTypes.Count > 0)
            {
                retryPolicy.NonRetryableErrorTypes = policy.NonRetryableErrorTypes.ToArray();
            }
            return retryPolicy;
        }

        private static ApiCommon.Memo ToMemo(IReadOnlyDictionary<string, object?> memo)
        {
            var proto = new ApiCommon.Memo();
            foreach (var item in memo)
            {
                if (item.Value == null)
                {
                    throw new ArgumentException($"Memo value for {item.Key} is null", nameof(memo));
                }
                proto.Fields.Add(item.Key, ToPayload(item.Value));
            }
            return proto;
        }

        private static ApiCommon.Priority ToPriority(Temporalio.Common.Priority priority) => new()
        {
            PriorityKey = priority.PriorityKey ?? 0,
            FairnessKey = priority.FairnessKey ?? string.Empty,
            FairnessWeight = priority.FairnessWeight ?? 0f,
        };

        private static ApiWorkflow.VersioningOverride ToVersioningOverride(Temporalio.Common.VersioningOverride versioningOverride) =>
            versioningOverride switch
            {
                Temporalio.Common.VersioningOverride.Pinned pinned => new ApiWorkflow.VersioningOverride
                {
#pragma warning disable CS0612
                    Behavior = Temporalio.Api.Enums.V1.VersioningBehavior.Pinned,
                    PinnedVersion = pinned.Version.ToCanonicalString(),
#pragma warning restore CS0612
                    Pinned = new ApiWorkflow.VersioningOverride.Types.PinnedOverride
                    {
                        Version = new ApiDeployment.WorkerDeploymentVersion
                        {
                            DeploymentName = pinned.Version.DeploymentName,
                            BuildId = pinned.Version.BuildId,
                        },
                        Behavior = (ApiWorkflow.VersioningOverride.Types.PinnedOverrideBehavior)pinned.Behavior,
                    },
                },
                Temporalio.Common.VersioningOverride.AutoUpgrade _ => new ApiWorkflow.VersioningOverride
                {
#pragma warning disable CS0612
                    Behavior = Temporalio.Api.Enums.V1.VersioningBehavior.AutoUpgrade,
#pragma warning restore CS0612
                    AutoUpgrade = true,
                },
                _ => throw new ArgumentException("Unknown versioning override type", nameof(versioningOverride)),
            };
    }
}
