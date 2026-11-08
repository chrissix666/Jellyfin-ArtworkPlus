using System;
using System.IO;
using SkiaSharp;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Renders a person's name as a clearlogo PNG with SkiaSharp (Jellyfin
/// ships SkiaSharp for its own image pipeline, so nothing new travels with
/// the DLL): 800 x 310, transparent, white fill, black outline, font size
/// found by binary search so the text fits the canvas minus a margin, centred.
/// Stroke and outline are percent of the font size - the same numbers
/// the live Text stage uses in CSS, so the file and the live text agree.
/// Text goes through SKFont, the API both SkiaSharp 2.88 (Jellyfin 10.10)
/// and 3.x (Jellyfin 12.1) carry; glyphs are antialiased, no subpixel.
/// </summary>
public sealed class LogoTextRenderer
{
    public const int Width = 800;
    public const int Height = 310;
    private const int Margin = 20;

    private readonly string _fontsFolder;

    public LogoTextRenderer(string fontsFolder)
    {
        _fontsFolder = fontsFolder;
    }

    public void WritePng(string text, string fontFile, string targetPath, double strokeEm, double outlineEm)
    {
        var fontPath = Path.Combine(_fontsFolder, fontFile.Replace('/', Path.DirectorySeparatorChar));
        using var typeface = SKTypeface.FromFile(fontPath) ?? throw new FileNotFoundException("font not readable", fontPath);
        var rendered = GlyphSafeText(typeface, text);

        var size = FitSize(typeface, rendered, Width - 2 * Margin, Height - 2 * Margin);
        using var font = NewFont(typeface, size);
        var bounds = Measure(font, rendered);

        var x = (Width - bounds.Width) / 2f - bounds.Left;
        var y = (Height - bounds.Height) / 2f - bounds.Top;

        using var surface = SKSurface.Create(new SKImageInfo(Width, Height, SKColorType.Rgba8888, SKAlphaType.Premul));
        var canvas = surface.Canvas;
        canvas.Clear(SKColors.Transparent);

        // Outline first (black, stroked, width = outline + stroke so the
        // rim stays visible outside the thickened white), then the white
        // body thickened by the stroke, then the plain white fill.
        var strokePx = (float)(strokeEm * 0.01 * size);
        var outlinePx = (float)(outlineEm * 0.01 * size);
        if (outlinePx > 0)
        {
            using var rim = new SKPaint { Color = SKColors.Black, IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 2 * (outlinePx + strokePx), StrokeJoin = SKStrokeJoin.Round };
            canvas.DrawText(rendered, x, y, font, rim);
        }

        if (strokePx > 0)
        {
            using var body = new SKPaint { Color = SKColors.White, IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 2 * strokePx, StrokeJoin = SKStrokeJoin.Round };
            canvas.DrawText(rendered, x, y, font, body);
        }

        using var fill = new SKPaint { Color = SKColors.White, IsAntialias = true, Style = SKPaintStyle.Fill };
        canvas.DrawText(rendered, x, y, font, fill);

        using var image = surface.Snapshot();
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        using var stream = File.Create(targetPath);
        data.SaveTo(stream);
    }

    /// <summary>Largest size whose measured bounds fit the box (binary search).</summary>
    private static float FitSize(SKTypeface typeface, string text, float maxW, float maxH)
    {
        float lo = 8, hi = 400, best = 8;
        while (hi - lo > 0.5f)
        {
            var mid = (lo + hi) / 2f;
            using var font = NewFont(typeface, mid);
            var b = Measure(font, text);
            if (b.Width <= maxW && b.Height <= maxH) { best = mid; lo = mid; } else { hi = mid; }
        }

        return best;
    }

    /// <summary>Antialiased, non-subpixel glyphs (what SKPaint with IsAntialias = true produces).</summary>
    private static SKFont NewFont(SKTypeface typeface, float size)
    {
        return new SKFont(typeface, size) { Edging = SKFontEdging.Antialias, Subpixel = false };
    }

    /// <summary>Ink bounds of the text; SkiaSharp 2.88 measures bounds only from glyph ids, so both versions go that way.</summary>
    private static SKRect Measure(SKFont font, string text)
    {
        var glyphs = new ushort[font.CountGlyphs(text)];
        font.GetGlyphs(text, glyphs);
        font.MeasureText(glyphs, out var bounds);
        return bounds;
    }

    /// <summary>
    /// The same glyph rule as the live text: a font missing an
    /// accented letter gets the NFD-normalised name (Á -> A), with the
    /// four letters normalisation cannot split mapped by hand.
    /// </summary>
    public static string GlyphSafeText(SKTypeface typeface, string text)
    {
        var missing = false;
        foreach (var ch in text)
        {
            if (ch == ' ' || typeface.GetGlyph(ch) != 0) { continue; }
            missing = true;
            break;
        }

        return missing ? Normalise(text) : text;
    }

    public static string Normalise(string text)
    {
        var mapped = text.Replace("ß", "ss").Replace("ø", "o").Replace("Ø", "O").Replace("æ", "ae").Replace("Æ", "AE").Replace("ł", "l").Replace("Ł", "L").Replace("đ", "d").Replace("Đ", "D");
        var sb = new System.Text.StringBuilder();
        foreach (var ch in mapped.Normalize(System.Text.NormalizationForm.FormD))
        {
            if (System.Globalization.CharUnicodeInfo.GetUnicodeCategory(ch) != System.Globalization.UnicodeCategory.NonSpacingMark) { sb.Append(ch); }
        }

        return sb.ToString();
    }
}
