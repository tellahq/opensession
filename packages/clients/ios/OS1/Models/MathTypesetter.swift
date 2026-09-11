import Foundation

/// Display math in a message: a ```math fence or a `$$` block on its own
/// lines (docs/blocks.md, "Math"). The web typesets with KaTeX; there is no
/// KaTeX here, so this sets the TeX the models actually write, as text: Greek
/// letters and operators become their Unicode forms, `^` and `_` become
/// raised and lowered runs, `\frac{a}{b}` becomes `a/b` with each side
/// grouped, and letters are marked as identifiers for the view to italicise.
/// Anything outside the vocabulary keeps the fence as code, so a formula
/// never renders wrong, only plain.
enum MathTypesetter {
    /// One run of set text. `script` lifts or lowers it; `identifier` marks a
    /// variable name, set in italic the way a formula reads.
    struct Run: Equatable {
        enum Script: Equatable { case normal, superscript, lowered }

        var text: String
        var script: Script = .normal
        var identifier = false
        var bold = false
    }

    /// Lines of runs (a `\\` splits lines). Nil when a command is unknown or
    /// the braces do not balance.
    static func typeset(_ source: String) -> [[Run]]? {
        var parser = Parser(chars: Array(source))
        guard let runs = parser.parseSequence(until: nil), parser.index == parser.chars.count else {
            return nil
        }
        var lines: [[Run]] = [[]]
        for run in runs {
            if run.text == "\n", run.script == .normal, !run.identifier {
                lines.append([])
            } else {
                lines[lines.count - 1].append(run)
            }
        }
        return lines.map(merge).filter { !$0.isEmpty }.nonEmpty
    }

    /// Adjacent runs of one style fold into one, so a view draws few pieces.
    private static func merge(_ runs: [Run]) -> [Run] {
        var out: [Run] = []
        for run in runs {
            if var last = out.last, last.script == run.script, last.identifier == run.identifier,
               last.bold == run.bold {
                last.text += run.text
                out[out.count - 1] = last
            } else {
                out.append(run)
            }
        }
        return out
    }

    // MARK: - Vocabulary

    private static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε",
        "zeta": "ζ", "eta": "η", "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ",
        "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π", "rho": "ρ", "sigma": "σ",
        "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ",
        "Upsilon": "Υ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "times": "×", "cdot": "·", "pm": "±", "mp": "∓", "div": "÷", "ast": "∗", "star": "⋆",
        "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠", "approx": "≈",
        "equiv": "≡", "sim": "∼", "simeq": "≃", "propto": "∝", "ll": "≪", "gg": "≫",
        "infty": "∞", "partial": "∂", "nabla": "∇", "sum": "∑", "prod": "∏", "int": "∫",
        "iint": "∬", "oint": "∮", "sqrt": "√", "to": "→", "rightarrow": "→", "Rightarrow": "⇒",
        "leftarrow": "←", "Leftarrow": "⇐", "leftrightarrow": "↔", "Leftrightarrow": "⇔",
        "mapsto": "↦", "implies": "⇒", "iff": "⇔", "in": "∈", "notin": "∉", "ni": "∋",
        "subset": "⊂", "subseteq": "⊆", "supset": "⊃", "supseteq": "⊇", "cup": "∪", "cap": "∩",
        "setminus": "∖", "emptyset": "∅", "varnothing": "∅", "forall": "∀", "exists": "∃",
        "neg": "¬", "lnot": "¬", "land": "∧", "wedge": "∧", "lor": "∨", "vee": "∨",
        "cdots": "⋯", "ldots": "…", "dots": "…", "vdots": "⋮", "ddots": "⋱",
        "angle": "∠", "perp": "⊥", "parallel": "∥", "degree": "°", "circ": "∘",
        "hbar": "ℏ", "ell": "ℓ", "Re": "ℜ", "Im": "ℑ", "aleph": "ℵ", "prime": "′",
        "lfloor": "⌊", "rfloor": "⌋", "lceil": "⌈", "rceil": "⌉", "langle": "⟨", "rangle": "⟩",
        "mathbb{R}": "ℝ", "mathbb{N}": "ℕ", "mathbb{Z}": "ℤ", "mathbb{Q}": "ℚ", "mathbb{C}": "ℂ",
        "quad": "  ", "qquad": "    ", ",": " ", ";": " ", ":": " ", "!": "", " ": " ",
        "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "#": "#", "_": "_", "|": "‖",
        "lim": "lim", "log": "log", "ln": "ln", "exp": "exp", "sin": "sin", "cos": "cos",
        "tan": "tan", "min": "min", "max": "max", "det": "det", "dim": "dim", "gcd": "gcd",
        "arg": "arg", "sup": "sup", "inf": "inf", "mod": "mod",
    ]

    /// Commands that wrap their argument and change nothing but the face.
    private static let wrappers: Set<String> = [
        "mathrm", "mathit", "mathsf", "mathtt", "mathcal", "mathfrak", "operatorname",
        "textrm", "textit", "textbf", "left", "right", "displaystyle", "textstyle",
        "big", "Big", "bigl", "bigr", "Bigl", "Bigr",
    ]

    private struct Parser {
        let chars: [Character]
        var index = 0

        init(chars: [Character]) { self.chars = chars }

        /// Runs up to `until` (a closing brace) or the end.
        mutating func parseSequence(until close: Character?) -> [Run]? {
            var runs: [Run] = []
            while index < chars.count {
                let c = chars[index]
                if let close, c == close { return runs }
                if c == "}" { return nil }
                if c == "{" {
                    index += 1
                    guard let inner = parseSequence(until: "}") else { return nil }
                    index += 1
                    runs.append(contentsOf: inner)
                    continue
                }
                if c == "^" || c == "_" {
                    index += 1
                    guard let argument = parseArgument() else { return nil }
                    let script: Run.Script = c == "^" ? .superscript : .lowered
                    runs.append(contentsOf: argument.map { run in
                        var run = run
                        run.script = script
                        return run
                    })
                    continue
                }
                if c == "\\" {
                    guard let command = parseCommand() else { return nil }
                    runs.append(contentsOf: command)
                    continue
                }
                index += 1
                if c == "\n" || c == "\r" { continue }
                if c == "&" {
                    runs.append(Run(text: "  "))
                    continue
                }
                if c.isLetter {
                    runs.append(Run(text: String(c), identifier: true))
                } else if c == "*" {
                    runs.append(Run(text: "∗"))
                } else if c == "-" {
                    runs.append(Run(text: "−"))
                } else {
                    runs.append(Run(text: String(c)))
                }
            }
            return close == nil ? runs : nil
        }

        /// One brace group, or one token, after `^`, `_`, `\frac`, `\sqrt`.
        private mutating func parseArgument() -> [Run]? {
            while index < chars.count, chars[index] == " " { index += 1 }
            guard index < chars.count else { return nil }
            if chars[index] == "{" {
                index += 1
                guard let inner = parseSequence(until: "}") else { return nil }
                index += 1
                return inner
            }
            if chars[index] == "\\" { return parseCommand() }
            let c = chars[index]
            index += 1
            return [Run(text: c == "-" ? "−" : String(c), identifier: c.isLetter)]
        }

        private mutating func parseCommand() -> [Run]? {
            index += 1
            guard index < chars.count else { return nil }
            var name = ""
            if chars[index].isLetter {
                while index < chars.count, chars[index].isLetter {
                    name.append(chars[index])
                    index += 1
                }
            } else {
                name = String(chars[index])
                index += 1
            }
            switch name {
            case "\\":
                return [Run(text: "\n")]
            case "frac", "dfrac", "tfrac":
                guard let top = parseArgument(), let bottom = parseArgument() else { return nil }
                return group(top) + [Run(text: "⁄")] + group(bottom)
            case "sqrt":
                var degree: [Run] = []
                while index < chars.count, chars[index] == " " { index += 1 }
                if index < chars.count, chars[index] == "[" {
                    index += 1
                    guard let inner = parseSequence(until: "]") else { return nil }
                    index += 1
                    degree = inner.map { run in
                        var run = run
                        run.script = .superscript
                        return run
                    }
                }
                guard let radicand = parseArgument() else { return nil }
                return degree + [Run(text: "√")] + group(radicand)
            case "text", "mbox":
                guard let inner = parseArgument() else { return nil }
                return inner.map { run in
                    var run = run
                    run.identifier = false
                    return run
                }
            case "mathbf", "boldsymbol", "bm", "bf":
                guard let inner = parseArgument() else { return nil }
                return inner.map { run in
                    var run = run
                    run.bold = true
                    return run
                }
            case "mathbb":
                guard let inner = parseArgument(), inner.count == 1,
                      let symbol = MathTypesetter.symbols["mathbb{\(inner[0].text)}"]
                else { return nil }
                return [Run(text: symbol)]
            case "hat", "bar", "vec", "tilde", "dot", "overline":
                guard let inner = parseArgument() else { return nil }
                let mark: Character = switch name {
                case "hat": "\u{0302}"
                case "bar", "overline": "\u{0304}"
                case "vec": "\u{20D7}"
                case "tilde": "\u{0303}"
                default: "\u{0307}"
                }
                return inner.map { run in
                    var run = run
                    run.text += String(mark)
                    return run
                }
            case "begin", "end":
                // `\begin{aligned}` … `\end{aligned}`: the environment name is
                // read and dropped; `&` and `\\` inside do the layout.
                guard let inner = parseArgument(), !inner.isEmpty else { return nil }
                return []
            default:
                break
            }
            if MathTypesetter.wrappers.contains(name) { return [] }
            if let symbol = MathTypesetter.symbols[name] {
                return [Run(text: symbol)]
            }
            return nil
        }

        /// A multi-run argument is bracketed so `a+b` over `c` reads as such.
        private func group(_ runs: [Run]) -> [Run] {
            let bare = runs.count == 1 && runs[0].script == .normal
            return bare ? runs : [Run(text: "(")] + runs + [Run(text: ")")]
        }
    }
}

private extension Array {
    var nonEmpty: Self? { isEmpty ? nil : self }
}
