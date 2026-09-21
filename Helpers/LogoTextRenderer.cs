using System;
using System.IO;
using SkiaSharp;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// Session 134: renders a person's name as a clearlogo PNG with SkiaSharp
/// (Jellyfin 10.10 ships SkiaSharp 2.88 for its own image pipeline, so
/// nothing new travels with the DLL). The user's create_clearlogos script
/// 1:1: 800 x 310, transparent, white fill, black outline, font size found
/// by binary search so the text fits the canvas minus a margin, centred.
/// Stroke and outline are percent of the font size - the same numbers
/// the live Text stage uses in CSS, so the file and the live text agree.
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
        var bounds = new SKRect();
        using (var measure = new SKPaint { Typeface = typeface, TextSize = size, IsAntialias = true })
        {
            measure.MeasureText(rendered, ref bounds);
        }

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
            using var rim = new SKPaint { Typeface = typeface, TextSize = size, Color = SKColors.Black, IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 2 * (outlinePx + strokePx), StrokeJoin = SKStrokeJoin.Round };
            canvas.DrawText(rendered, x, y, rim);
        }

        if (strokePx > 0)
        {
            using var body = new SKPaint { Typeface = typeface, TextSize = size, Color = SKColors.White, IsAntialias = true, Style = SKPaintStyle.Stroke, StrokeWidth = 2 * strokePx, StrokeJoin = SKStrokeJoin.Round };
            canvas.DrawText(rendered, x, y, body);
        }

        using var fill = new SKPaint { Typeface = typeface, TextSize = size, Color = SKColors.White, IsAntialias = true, Style = SKPaintStyle.Fill };
        canvas.DrawText(rendered, x, y, fill);

        using var image = surface.Snapshot();
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        using var stream = File.Create(targetPath);
        data.SaveTo(stream);
    }

    /// <summary>Largest size whose measured bounds fit the box (binary search, like the user's script).</summary>
    private static float FitSize(SKTypeface typeface, string text, float maxW, float maxH)
    {
        float lo = 8, hi = 400, best = 8;
        while (hi - lo > 0.5f)
        {
            var mid = (lo + hi) / 2f;
            using var paint = new SKPaint { Typeface = typeface, TextSize = mid, IsAntialias = true };
            var b = new SKRect();
            paint.MeasureText(text, ref b);
            if (b.Width <= maxW && b.Height <= maxH) { best = mid; lo = mid; } else { hi = mid; }
        }

        return best;
    }

    /// <summary>
    /// The same glyph rule as the live text (concept D2): a font missing an
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
