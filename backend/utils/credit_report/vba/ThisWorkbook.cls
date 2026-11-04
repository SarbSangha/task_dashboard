Option Explicit
' Interactive dashboard workbook: one set of filters on every sheet.
'
' Each sheet's filter box (named bx_<filter>_<sheet suffix>) normally holds a
' formula showing the Dashboard's filter. Picking a value in any sheet's box
' makes it the Dashboard's filter, then every sheet's box shows the Dashboard
' again - so a change made on any sheet reaches every sheet. A change on the
' Dashboard also puts back any box that was changed on its own sheet.
' Without macros the workbook still works: Dashboard changes reach every
' sheet, and a box picked on a sheet filters that sheet only.
'
' Built into vbaProject.bin by build_vba.ps1 (see dashboard_workbook.py).

Private Const FILTERS As String = "fTool,fAcct,fDept,fPerson,fClient,fSearch,fFrom,fTo"
Private Const LISTED As String = ",fTool,fAcct,fDept,fPerson,fClient,"   ' never blank

Private Sub Workbook_SheetChange(ByVal Sh As Object, ByVal Target As Range)
    Dim f As Variant, dash As Range, box As Range, nm As Name, prefix As String, hit As Boolean
    On Error GoTo Done
    Application.EnableEvents = False
    For Each f In Split(FILTERS, ",")
        Set dash = Me.Names(CStr(f)).RefersToRange
        prefix = "bx_" & f & "_"
        hit = False      ' (Intersect fails on ranges of two sheets: compare the sheets first)
        If dash.Worksheet.Name = Sh.Name Then hit = Not Intersect(Target, dash.MergeArea) Is Nothing
        If Not hit Then
            For Each nm In Me.Names
                If Left$(nm.Name, Len(prefix)) = prefix Then
                    Set box = nm.RefersToRange
                    If box.Worksheet.Name = Sh.Name Then
                        If Not Intersect(Target, box.MergeArea) Is Nothing Then
                            hit = True
                            If Not box.HasFormula Then
                                ' a cleared list box keeps the Dashboard's value
                                If Len(CStr(box.Value)) > 0 Or InStr(LISTED, "," & f & ",") = 0 Then
                                    dash.Value = box.Value
                                End If
                            End If
                            Exit For
                        End If
                    End If
                End If
            Next nm
        End If
        If hit Then
            For Each nm In Me.Names
                If Left$(nm.Name, Len(prefix)) = prefix Then
                    nm.RefersToRange.Formula = Follow(dash, CStr(f))
                End If
            Next nm
        End If
    Next f
Done:
    Application.EnableEvents = True
End Sub

' A From / To box opens a calendar when it is clicked (or double-clicked).
Private Sub Workbook_SheetSelectionChange(ByVal Sh As Object, ByVal Target As Range)
    PickDate Sh, Target
End Sub

Private Sub Workbook_SheetBeforeDoubleClick(ByVal Sh As Object, ByVal Target As Range, Cancel As Boolean)
    If PickDate(Sh, Target) Then Cancel = True
End Sub

' Target is a From / To box (the Dashboard's or a sheet's): show the calendar
' and put the day picked in the box (its change then reaches every sheet).
Private Function PickDate(ByVal Sh As Object, ByVal Target As Range) As Boolean
    Dim f As Variant, nm As Name, box As Range, shown As Boolean
    On Error GoTo Done
    If Target.Cells.CountLarge > 8 Then Exit Function
    For Each f In Array("fFrom", "fTo")
        For Each nm In Me.Names
            If nm.Name = f Or Left$(nm.Name, Len(f) + 4) = "bx_" & f & "_" Then
                If nm.RefersToRange.Worksheet.Name = Sh.Name Then
                    If Not Intersect(Target, nm.RefersToRange.MergeArea) Is Nothing Then
                        Set box = nm.RefersToRange
                        Exit For
                    End If
                End If
            End If
        Next nm
        If Not box Is Nothing Then Exit For
    Next f
    If box Is Nothing Then Exit Function
    PickDate = True
    shown = True
    DatePick.Setup box.Value, Me.Names("kStart").RefersToRange.Value, Me.Names("kEnd").RefersToRange.Value, _
                   IIf(f = "fFrom", "From", "To")
    DatePick.Show
    Select Case DatePick.Result
        Case 1: box.Value = DatePick.Picked
        Case 2: box.MergeArea.ClearContents
    End Select
Done:
    If shown Then Unload DatePick
End Function

' The formula a sheet's box holds to show the Dashboard's filter.
Private Function Follow(ByVal dash As Range, ByVal f As String) As String
    Dim ref As String
    ref = "'" & dash.Worksheet.Name & "'!" & dash.Address
    If InStr(LISTED, "," & f & ",") > 0 Then
        Follow = "=" & ref
    Else
        Follow = "=IF(" & ref & "="""",""""," & ref & ")"
    End If
End Function
