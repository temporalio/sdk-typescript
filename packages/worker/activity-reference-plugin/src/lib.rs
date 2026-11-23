use std::collections::{HashMap, HashSet};

use swc_core::{
    common::{BytePos, DUMMY_SP, Span, SyntaxContext, errors::HANDLER},
    ecma::{
        ast::*,
        utils::{private_ident, prop_name_eq},
        visit::{Visit, VisitWith},
    },
    plugin::{plugin_transform, proxies::TransformPluginProgramMetadata},
};

struct ActivityImport {
    local: Ident,
    name: String,
    explicit: bool,
    direct_uses: HashSet<BytePos>,
    other_uses: Vec<Span>,
}

fn error(span: Span, message: &str) {
    HANDLER.with(|handler| handler.struct_span_err(span, message).emit());
}

fn export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::Ident(ident) => ident.sym.to_string(),
        ModuleExportName::Str(string) => string.value.to_string_lossy().into_owned(),
        _ => panic!("Unknown module export name"),
    }
}

fn activity_attribute(import: &ImportDecl) -> bool {
    let Some(attributes) = &import.with else {
        return false;
    };
    for property in &attributes.props {
        let PropOrSpread::Prop(property) = property else {
            continue;
        };
        let Prop::KeyValue(property) = &**property else {
            continue;
        };
        if prop_name_eq(&property.key, "temporal") {
            if !matches!(&*property.value, Expr::Lit(Lit::Str(value)) if value.value == *"activity")
            {
                error(
                    import.span,
                    "Expected with { temporal: 'activity' } for an Activity-reference import.",
                );
            }
            return true;
        }
    }
    false
}

struct DirectCalls<'a> {
    apis: &'a HashSet<Id>,
    imports: &'a mut HashMap<Id, ActivityImport>,
}

impl Visit for DirectCalls<'_> {
    fn visit_import_decl(&mut self, _: &ImportDecl) {}

    fn visit_call_expr(&mut self, call: &CallExpr) {
        if let Callee::Expr(callee) = &call.callee
            && let Expr::Ident(api) = &**callee
            && self.apis.contains(&api.to_id())
            && let Some(argument) = call.args.first()
            && argument.spread.is_none()
            && let Expr::Ident(reference) = &*argument.expr
            && let Some(activity) = self.imports.get_mut(&reference.to_id())
        {
            activity.direct_uses.insert(reference.span.lo);
        }
        call.visit_children_with(self);
    }
}

struct References<'a>(&'a mut HashMap<Id, ActivityImport>);

impl Visit for References<'_> {
    fn visit_import_decl(&mut self, _: &ImportDecl) {}

    fn visit_ident(&mut self, ident: &Ident) {
        if let Some(activity) = self.0.get_mut(&ident.to_id())
            && !activity.direct_uses.contains(&ident.span.lo)
        {
            activity.other_uses.push(ident.span);
        }
    }
}

fn reference_declaration(activity: ActivityImport, helper: &Ident) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        kind: VarDeclKind::Const,
        declare: false,
        decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(activity.local.into()),
            definite: false,
            init: Some(Box::new(Expr::Call(CallExpr {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                callee: Callee::Expr(Box::new(Expr::Ident(helper.clone()))),
                args: vec![ExprOrSpread {
                    spread: None,
                    expr: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: activity.name.into(),
                        raw: None,
                    }))),
                }],
                type_args: None,
            }))),
        }],
    }))))
}

#[plugin_transform]
pub fn transform(mut program: Program, _: TransformPluginProgramMetadata) -> Program {
    let Program::Module(module) = &mut program else {
        return program;
    };
    let mut imports = HashMap::new();
    let mut order = Vec::new();
    let mut apis = HashSet::new();
    for item in &module.body {
        let ModuleItem::ModuleDecl(ModuleDecl::Import(import)) = item else {
            continue;
        };
        let explicit = activity_attribute(import);
        if explicit && import.specifiers.is_empty() {
            error(
                import.span,
                "Activity-reference imports require named exports.",
            );
        }
        for specifier in &import.specifiers {
            let ImportSpecifier::Named(specifier) = specifier else {
                if explicit {
                    error(
                        import.span,
                        "Activity-reference imports require named exports; default and namespace imports are not supported.",
                    );
                }
                continue;
            };
            let name = specifier
                .imported
                .as_ref()
                .map(export_name)
                .unwrap_or_else(|| specifier.local.sym.to_string());
            let id = specifier.local.to_id();
            if import.src.value == *"@temporalio/workflow"
                && matches!(name.as_str(), "executeActivity" | "executeLocalActivity")
            {
                apis.insert(id);
            } else {
                order.push(id.clone());
                imports.insert(
                    id,
                    ActivityImport {
                        local: specifier.local.clone(),
                        name,
                        explicit,
                        direct_uses: HashSet::new(),
                        other_uses: Vec::new(),
                    },
                );
            }
        }
    }
    module.visit_with(&mut DirectCalls {
        apis: &apis,
        imports: &mut imports,
    });
    module.visit_with(&mut References(&mut imports));
    imports.retain(|_, activity| activity.explicit || !activity.direct_uses.is_empty());
    if imports.is_empty() {
        return program;
    }
    for activity in imports.values() {
        if !activity.explicit
            && let Some(span) = activity.other_uses.first()
        {
            error(
                *span,
                &format!(
                    "Activity import '{}' is also used outside direct executeActivity/executeLocalActivity calls. \
                 Mark its import with {{ temporal: 'activity' }} to pass an Activity reference through wrappers or factories.",
                    activity.local.sym
                ),
            );
        }
    }
    let helper = private_ident!("__temporal_createActivityReference");
    let mut body = vec![ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
        span: DUMMY_SP,
        specifiers: vec![ImportSpecifier::Named(ImportNamedSpecifier {
            span: DUMMY_SP,
            local: helper.clone(),
            imported: Some(ModuleExportName::Ident(Ident::new_no_ctxt(
                "createActivityReference".into(),
                DUMMY_SP,
            ))),
            is_type_only: false,
        })],
        src: Box::new(Str {
            span: DUMMY_SP,
            value: "@temporalio/workflow/internal".into(),
            raw: None,
        }),
        type_only: false,
        with: None,
        phase: ImportPhase::Evaluation,
    }))];
    // Remove only imports whose specifiers were replaced, not ordinary side-effect imports.
    module.body.retain_mut(|item| {
        if let ModuleItem::ModuleDecl(ModuleDecl::Import(import)) = item {
            let was_side_effect_import = import.specifiers.is_empty();
            import
                .specifiers
                .retain(|specifier| !imports.contains_key(&specifier.local().to_id()));
            return was_side_effect_import || !import.specifiers.is_empty();
        }
        true
    });
    for id in order {
        if let Some(activity) = imports.remove(&id) {
            body.push(reference_declaration(activity, &helper));
        }
    }
    body.append(&mut module.body);
    module.body = body;
    program
}
