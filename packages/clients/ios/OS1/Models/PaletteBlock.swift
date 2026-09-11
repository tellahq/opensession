import Foundation

/// The ```palette fence: one colour per line, rendered as a row of swatches
/// that copy their value on tap (docs/blocks.md, "Colour"). The grammar is
/// the web's `lib/palette-block.ts`: a value is a colour when it is a hex
/// form, a known colour function with a flat argument list, or a CSS colour
/// name. Only a value this grammar accepted is ever painted.
struct PaletteEntry: Equatable {
    /// The colour as written, trimmed. What the swatch shows and copies.
    var value: String
    /// Optional label, from either `#hex Name` or `Name: #hex`.
    var name: String
    /// sRGB components in 0...1, when the value can be computed here. A
    /// colour in a space this app does not convert (`color(xyz …)`) still
    /// lists, painted as unknown.
    var rgba: (red: Double, green: Double, blue: Double, alpha: Double)?

    static func == (lhs: PaletteEntry, rhs: PaletteEntry) -> Bool {
        lhs.value == rhs.value && lhs.name == rhs.name
    }
}

enum PaletteBlock {
    /// Every non-blank line as a colour, or nil when any line is not one: a
    /// fence with prose in it is not a palette and stays code.
    static func parse(_ source: String) -> [PaletteEntry]? {
        var entries: [PaletteEntry] = []
        for raw in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            guard let entry = parseLine(line) else { return nil }
            entries.append(entry)
        }
        return entries.isEmpty ? nil : entries
    }

    /// Whether `value` is a colour this block will paint and copy.
    static func isCssColor(_ value: String) -> Bool {
        isHex(value) || isColorFunction(value) || namedColors[value.lowercased()] != nil
    }

    private static func parseLine(_ line: String) -> PaletteEntry? {
        if let lead = leadingToken(line), isCssColor(lead) {
            let name = line.dropFirst(lead.count).trimmingCharacters(in: .whitespaces)
            return PaletteEntry(value: lead, name: name, rgba: rgba(of: lead))
        }
        guard let colon = line.firstIndex(of: ":"), colon > line.startIndex else { return nil }
        let name = line[..<colon].trimmingCharacters(in: .whitespaces)
        // A trailing `;` or `,` is how a colour arrives when the line was
        // lifted from a stylesheet or an object literal.
        var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        if let last = value.last, last == ";" || last == "," {
            value.removeLast()
            value = value.trimmingCharacters(in: .whitespaces)
        }
        guard !name.isEmpty, isCssColor(value) else { return nil }
        return PaletteEntry(value: value, name: name, rgba: rgba(of: value))
    }

    /// A line's leading token: hex, `fn(...)`, or a bare word, up to
    /// whitespace or the end. What the prefix form (`#hex Name`) reads its
    /// colour from.
    private static func leadingToken(_ line: String) -> String? {
        if line.hasPrefix("#") {
            let token = line.prefix { !$0.isWhitespace }
            return token.dropFirst().allSatisfy(\.isHexDigit) ? String(token) : nil
        }
        let word = line.prefix { $0.isLetter }
        guard !word.isEmpty else { return nil }
        let rest = line[word.endIndex...]
        if rest.first == "(" {
            guard let close = rest.firstIndex(of: ")") else { return nil }
            let token = line[line.startIndex...close]
            let after = line[line.index(after: close)...]
            guard after.isEmpty || after.first!.isWhitespace else { return nil }
            guard !token.dropFirst(word.count + 1).dropLast().contains(where: { $0 == "(" || $0 == ")" }) else {
                return nil
            }
            return String(token)
        }
        guard rest.isEmpty || rest.first!.isWhitespace else { return nil }
        return String(word)
    }

    private static func isHex(_ value: String) -> Bool {
        guard value.hasPrefix("#") else { return false }
        let digits = value.dropFirst()
        return [3, 4, 6, 8].contains(digits.count) && digits.allSatisfy(\.isHexDigit)
    }

    private static let functions: Set<String> = [
        "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color",
    ]

    /// A colour function with a flat argument list: numbers, percentages,
    /// angles, `none`, a colour space name, separators. No nested
    /// parentheses, so `color-mix()` and `calc()` stay out.
    private static func isColorFunction(_ value: String) -> Bool {
        guard let open = value.firstIndex(of: "("), value.hasSuffix(")") else { return false }
        let name = value[..<open].lowercased()
        guard functions.contains(name) else { return false }
        let args = value[value.index(after: open)..<value.index(before: value.endIndex)]
        guard args.contains(where: { $0.isNumber || $0.isLetter }) else { return false }
        return args.allSatisfy { char in
            char.isNumber || char.isLetter || " .%,/+-".contains(char)
        }
    }

    // MARK: - Painting

    private static func rgba(of value: String) -> (Double, Double, Double, Double)? {
        if isHex(value) { return hexRgba(value) }
        if let named = namedColors[value.lowercased()] {
            if value.lowercased() == "transparent" { return (0, 0, 0, 0) }
            return (
                Double((named >> 16) & 0xFF) / 255,
                Double((named >> 8) & 0xFF) / 255,
                Double(named & 0xFF) / 255,
                1
            )
        }
        guard let open = value.firstIndex(of: "(") else { return nil }
        let name = value[..<open].lowercased()
        let body = value[value.index(after: open)..<value.index(before: value.endIndex)]
        var alpha = 1.0
        var main = Substring(body)
        if let slash = body.firstIndex(of: "/") {
            main = body[..<slash]
            alpha = number(body[body.index(after: slash)...].trimmingCharacters(in: .whitespaces), scale: 1) ?? 1
        }
        var parts = main.split { $0 == "," || $0.isWhitespace }.map(String.init)
        if name == "color" {
            guard !parts.isEmpty else { return nil }
            let space = parts.removeFirst().lowercased()
            guard parts.count == 3, space == "srgb" || space == "display-p3" || space == "srgb-linear",
                  let r = number(parts[0], scale: 1), let g = number(parts[1], scale: 1),
                  let b = number(parts[2], scale: 1)
            else { return nil }
            if space == "srgb-linear" { return (gamma(r), gamma(g), gamma(b), alpha) }
            return (clamp(r), clamp(g), clamp(b), alpha)
        }
        if parts.count == 4, name == "rgba" || name == "hsla" || name == "rgb" || name == "hsl" {
            alpha = number(parts.removeLast(), scale: 1) ?? 1
        }
        guard parts.count == 3 else { return nil }
        switch name {
        case "rgb", "rgba":
            guard let r = number(parts[0], scale: 255), let g = number(parts[1], scale: 255),
                  let b = number(parts[2], scale: 255)
            else { return nil }
            return (clamp(r / 255), clamp(g / 255), clamp(b / 255), alpha)
        case "hsl", "hsla":
            guard let h = angle(parts[0]), let s = number(parts[1], scale: 100),
                  let l = number(parts[2], scale: 100)
            else { return nil }
            let (r, g, b) = hslToRgb(h: h, s: clamp(s / 100), l: clamp(l / 100))
            return (r, g, b, alpha)
        case "hwb":
            guard let h = angle(parts[0]), let w = number(parts[1], scale: 100),
                  let bl = number(parts[2], scale: 100)
            else { return nil }
            var white = clamp(w / 100), black = clamp(bl / 100)
            if white + black > 1 {
                let sum = white + black
                white /= sum
                black /= sum
            }
            let (r, g, b) = hslToRgb(h: h, s: 1, l: 0.5)
            let scale = 1 - white - black
            return (r * scale + white, g * scale + white, b * scale + white, alpha)
        case "lab", "lch", "oklab", "oklch":
            let ok = name.hasPrefix("ok")
            let polar = name.hasSuffix("ch")
            // Percent scales per CSS Color 4: L is 100 (1 for ok), a/b are
            // ±125 (±0.4 for ok), chroma is 150 (0.4 for ok).
            guard let l = number(parts[0], scale: ok ? 1 : 100),
                  let second = number(parts[1], scale: polar ? (ok ? 0.4 : 150) : (ok ? 0.4 : 125))
            else { return nil }
            var a = second, b = 0.0
            if polar {
                guard let hue = angle(parts[2]) else { return nil }
                a = second * cos(hue * .pi / 180)
                b = second * sin(hue * .pi / 180)
            } else {
                guard let third = number(parts[2], scale: ok ? 0.4 : 125) else { return nil }
                b = third
            }
            return ok
                ? oklabToRgb(l: l, a: a, b: b, alpha: alpha)
                : labToRgb(l: l, a: a, b: b, alpha: alpha)
        default:
            return nil
        }
    }

    private static func hexRgba(_ value: String) -> (Double, Double, Double, Double)? {
        var digits = Array(value.dropFirst())
        if digits.count == 3 || digits.count == 4 {
            digits = digits.flatMap { [$0, $0] }
        }
        guard let bits = UInt64(String(digits), radix: 16) else { return nil }
        let alpha = digits.count == 8 ? Double(bits & 0xFF) / 255 : 1
        let rgb = digits.count == 8 ? bits >> 8 : bits
        return (
            Double((rgb >> 16) & 0xFF) / 255,
            Double((rgb >> 8) & 0xFF) / 255,
            Double(rgb & 0xFF) / 255,
            alpha
        )
    }

    /// A number, or a percentage of `scale`. `none` is zero.
    private static func number(_ text: String, scale: Double) -> Double? {
        if text.lowercased() == "none" { return 0 }
        if text.hasSuffix("%") {
            return Double(text.dropLast()).map { $0 / 100 * scale }
        }
        return Double(text)
    }

    private static func angle(_ text: String) -> Double? {
        let lower = text.lowercased()
        if lower == "none" { return 0 }
        for (unit, factor) in [("deg", 1.0), ("grad", 0.9), ("rad", 180 / Double.pi), ("turn", 360.0)]
        where lower.hasSuffix(unit) {
            return Double(lower.dropLast(unit.count)).map { $0 * factor }
        }
        return Double(lower)
    }

    private static func clamp(_ value: Double) -> Double { min(1, max(0, value)) }

    private static func gamma(_ linear: Double) -> Double {
        let v = clamp(linear)
        return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
    }

    private static func hslToRgb(h: Double, s: Double, l: Double) -> (Double, Double, Double) {
        let hue = (h.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 360
        func channel(_ t: Double) -> Double {
            var t = t
            if t < 0 { t += 1 }
            if t > 1 { t -= 1 }
            let q = l < 0.5 ? l * (1 + s) : l + s - l * s
            let p = 2 * l - q
            if t < 1 / 6 { return p + (q - p) * 6 * t }
            if t < 1 / 2 { return q }
            if t < 2 / 3 { return p + (q - p) * (2 / 3 - t) * 6 }
            return p
        }
        if s == 0 { return (l, l, l) }
        return (channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3))
    }

    private static func oklabToRgb(l: Double, a: Double, b: Double, alpha: Double) -> (Double, Double, Double, Double) {
        let l_ = l + 0.3963377774 * a + 0.2158037573 * b
        let m_ = l - 0.1055613458 * a - 0.0638541728 * b
        let s_ = l - 0.0894841775 * a - 1.2914855480 * b
        let l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_
        let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        let bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
        return (gamma(r), gamma(g), gamma(bl), alpha)
    }

    private static func labToRgb(l: Double, a: Double, b: Double, alpha: Double) -> (Double, Double, Double, Double) {
        let fy = (l + 16) / 116
        let fx = fy + a / 500
        let fz = fy - b / 200
        func inverse(_ t: Double) -> Double {
            t > 6.0 / 29 ? t * t * t : 3 * (6.0 / 29) * (6.0 / 29) * (t - 4.0 / 29)
        }
        // D50 white, as CSS Lab specifies.
        let x = 0.9642 * inverse(fx), y = 1.0 * inverse(fy), z = 0.8251 * inverse(fz)
        // Bradford-adapted XYZ(D50) → linear sRGB.
        let r = 3.1338561 * x - 1.6168667 * y - 0.4906146 * z
        let g = -0.9787684 * x + 1.9161415 * y + 0.0334540 * z
        let bl = 0.0719453 * x - 0.2289914 * y + 1.4052427 * z
        return (gamma(r), gamma(g), gamma(bl), alpha)
    }

    /// CSS Color Level 4 named colours, plus `transparent`.
    static let namedColors: [String: UInt32] = [
        "aliceblue": 0xF0F8FF, "antiquewhite": 0xFAEBD7, "aqua": 0x00FFFF, "aquamarine": 0x7FFFD4,
        "azure": 0xF0FFFF, "beige": 0xF5F5DC, "bisque": 0xFFE4C4, "black": 0x000000,
        "blanchedalmond": 0xFFEBCD, "blue": 0x0000FF, "blueviolet": 0x8A2BE2, "brown": 0xA52A2A,
        "burlywood": 0xDEB887, "cadetblue": 0x5F9EA0, "chartreuse": 0x7FFF00, "chocolate": 0xD2691E,
        "coral": 0xFF7F50, "cornflowerblue": 0x6495ED, "cornsilk": 0xFFF8DC, "crimson": 0xDC143C,
        "cyan": 0x00FFFF, "darkblue": 0x00008B, "darkcyan": 0x008B8B, "darkgoldenrod": 0xB8860B,
        "darkgray": 0xA9A9A9, "darkgreen": 0x006400, "darkgrey": 0xA9A9A9, "darkkhaki": 0xBDB76B,
        "darkmagenta": 0x8B008B, "darkolivegreen": 0x556B2F, "darkorange": 0xFF8C00, "darkorchid": 0x9932CC,
        "darkred": 0x8B0000, "darksalmon": 0xE9967A, "darkseagreen": 0x8FBC8F, "darkslateblue": 0x483D8B,
        "darkslategray": 0x2F4F4F, "darkslategrey": 0x2F4F4F, "darkturquoise": 0x00CED1, "darkviolet": 0x9400D3,
        "deeppink": 0xFF1493, "deepskyblue": 0x00BFFF, "dimgray": 0x696969, "dimgrey": 0x696969,
        "dodgerblue": 0x1E90FF, "firebrick": 0xB22222, "floralwhite": 0xFFFAF0, "forestgreen": 0x228B22,
        "fuchsia": 0xFF00FF, "gainsboro": 0xDCDCDC, "ghostwhite": 0xF8F8FF, "gold": 0xFFD700,
        "goldenrod": 0xDAA520, "gray": 0x808080, "green": 0x008000, "greenyellow": 0xADFF2F,
        "grey": 0x808080, "honeydew": 0xF0FFF0, "hotpink": 0xFF69B4, "indianred": 0xCD5C5C,
        "indigo": 0x4B0082, "ivory": 0xFFFFF0, "khaki": 0xF0E68C, "lavender": 0xE6E6FA,
        "lavenderblush": 0xFFF0F5, "lawngreen": 0x7CFC00, "lemonchiffon": 0xFFFACD, "lightblue": 0xADD8E6,
        "lightcoral": 0xF08080, "lightcyan": 0xE0FFFF, "lightgoldenrodyellow": 0xFAFAD2, "lightgray": 0xD3D3D3,
        "lightgreen": 0x90EE90, "lightgrey": 0xD3D3D3, "lightpink": 0xFFB6C1, "lightsalmon": 0xFFA07A,
        "lightseagreen": 0x20B2AA, "lightskyblue": 0x87CEFA, "lightslategray": 0x778899, "lightslategrey": 0x778899,
        "lightsteelblue": 0xB0C4DE, "lightyellow": 0xFFFFE0, "lime": 0x00FF00, "limegreen": 0x32CD32,
        "linen": 0xFAF0E6, "magenta": 0xFF00FF, "maroon": 0x800000, "mediumaquamarine": 0x66CDAA,
        "mediumblue": 0x0000CD, "mediumorchid": 0xBA55D3, "mediumpurple": 0x9370DB, "mediumseagreen": 0x3CB371,
        "mediumslateblue": 0x7B68EE, "mediumspringgreen": 0x00FA9A, "mediumturquoise": 0x48D1CC,
        "mediumvioletred": 0xC71585, "midnightblue": 0x191970, "mintcream": 0xF5FFFA, "mistyrose": 0xFFE4E1,
        "moccasin": 0xFFE4B5, "navajowhite": 0xFFDEAD, "navy": 0x000080, "oldlace": 0xFDF5E6,
        "olive": 0x808000, "olivedrab": 0x6B8E23, "orange": 0xFFA500, "orangered": 0xFF4500,
        "orchid": 0xDA70D6, "palegoldenrod": 0xEEE8AA, "palegreen": 0x98FB98, "paleturquoise": 0xAFEEEE,
        "palevioletred": 0xDB7093, "papayawhip": 0xFFEFD5, "peachpuff": 0xFFDAB9, "peru": 0xCD853F,
        "pink": 0xFFC0CB, "plum": 0xDDA0DD, "powderblue": 0xB0E0E6, "purple": 0x800080,
        "rebeccapurple": 0x663399, "red": 0xFF0000, "rosybrown": 0xBC8F8F, "royalblue": 0x4169E1,
        "saddlebrown": 0x8B4513, "salmon": 0xFA8072, "sandybrown": 0xF4A460, "seagreen": 0x2E8B57,
        "seashell": 0xFFF5EE, "sienna": 0xA0522D, "silver": 0xC0C0C0, "skyblue": 0x87CEEB,
        "slateblue": 0x6A5ACD, "slategray": 0x708090, "slategrey": 0x708090, "snow": 0xFFFAFA,
        "springgreen": 0x00FF7F, "steelblue": 0x4682B4, "tan": 0xD2B48C, "teal": 0x008080,
        "thistle": 0xD8BFD8, "tomato": 0xFF6347, "turquoise": 0x40E0D0, "violet": 0xEE82EE,
        "wheat": 0xF5DEB3, "white": 0xFFFFFF, "whitesmoke": 0xF5F5F5, "yellow": 0xFFFF00,
        "yellowgreen": 0x9ACD32, "transparent": 0x000000,
    ]
}
