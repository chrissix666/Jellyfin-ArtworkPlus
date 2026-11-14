using SixLabors.ImageSharp.Formats;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.Formats.Png;
using SixLabors.ImageSharp.Formats.Webp;

namespace Jellyfin.Plugin.ArtworkPlus.Helpers;

/// <summary>
/// How the game case pictures (GameCasePictures, /ThreejsCase/game/{id}/image) are decoded with ImageSharp: only JPEG, PNG
/// and WebP are known, so a TIFF (or any other format) is refused as unknown before a decoder runs - ImageSharp 3.1.12 has
/// TIFF decoder advisories (GHSA-v76p-62qx-wwq2, GHSA-wmxv-xphr-5c9g), and this route reads files from the games' folders.
/// ICC profiles (GHSA-gwg2-r3hj-4w44, CLUT parsing): ImageSharp 3.1.12 only reads a profile's header while decoding
/// (JpegDecoderCore.InitIccProfile -> IccProfile.CheckIsValid -> Header, IccProfile.cs:145-162 / 180-195) and copies the raw
/// bytes when encoding (IccProfile.ToByteArray, IccProfile.cs:168-178); the tag data with its CLUTs is parsed only when
/// IccProfile.Entries is read (IccProfile.cs:84-90 / 197-212), which this code never does.
/// </summary>
public static class SafeImages
{
    /// <summary>JPEG, PNG and WebP only.</summary>
    public static readonly SixLabors.ImageSharp.Configuration Formats = new(
        new JpegConfigurationModule(), new PngConfigurationModule(), new WebpConfigurationModule());

    /// <summary>Decoding with metadata (the EXIF orientation of a game picture).</summary>
    public static readonly DecoderOptions WithMetadata = new() { Configuration = Formats };
}
